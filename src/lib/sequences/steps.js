// Sequence step handlers. Each function executes ONE step against
// a single (sequence, enrollment, contact) tuple and returns
// whatever the runner needs to advance — message id for sends,
// nothing for side-effect-only steps, target step_order for
// branches.
//
// All handlers share the same dispatch signature so the runner can
// route by step.type without a case-per-call:
//
//   handler(db, { step, sequence, contact, enrollment })
//
// Some handlers ignore some args (e.g. webhookStep doesn't touch db).
// All accept a destructured ctx so adding new context (e.g. an
// abort signal, a tracing tag) doesn't break the call sites.
//
// Step types covered (mig 087 / 089 / 091):
//   email, whatsapp, sms                — message sends
//   apply_tag, update_field             — contact mutations
//   branch                              — picks a continuation
//   webhook                             — outbound HTTP
//   internal_task                       — creates an activity row
//
// `wait` is not a handler — the runner just bumps next_step_at and
// returns; nothing to send.

import {
  sendTransactionalEmail,
  applyMergeTags,
  buildUnsubscribeUrl,
  appendUnsubscribeFooter,
} from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import {
  sendTemplateMessage,
  buildTemplateComponents,
  getOrCreateConversation,
  renderTemplateBody,
} from '@/lib/whatsapp'
import { sendLocationSms, TwilioError } from '@/lib/twilio'
import { getLocationBranding } from '@/lib/location-branding'

// ── email ───────────────────────────────────────────────────────

export async function sendEmailStep(db, { enrollment: _enrollment, step, sequence, contact }) {
  if (!contact?.email) {
    throw new Error('Contact has no email address — cannot send email step.')
  }
  // Consent/deliverability gate — mirror the SMS step + event-reminders +
  // booking-confirmations. Without it an active sequence keeps emailing a
  // contact who has since unsubscribed/bounced/complained (Postmark
  // reputation + GDPR). Throwing routes to the standard sequence error path.
  if (contact.email_status && ['bounced', 'complained', 'unsubscribed'].includes(contact.email_status)) {
    throw new Error(`Contact's email_status is '${contact.email_status}' — refusing to send sequence email.`)
  }

  // Resolve content: inline OR via template_id reference.
  let subject = step.subject
  let html = step.html_content
  if (!html && step.template_id) {
    const { data: tpl } = await db
      .from('email_templates')
      .select('subject, html_content')
      .eq('id', step.template_id)
      .single()
    if (tpl) {
      subject = subject || tpl.subject
      html = tpl.html_content
    }
  }
  if (!html) throw new Error('Step has no content (no html_content and no template_id).')

  // Merge tags substitution — supports {{first_name}}, {{full_name}}
  // etc, same shape as campaigns (see src/lib/postmark.js#applyMergeTags).
  // UNSUB.1 — pass the per-contact unsubscribe URL through so inline
  // {{unsubscribe_url}} tokens still resolve; then auto-append the
  // 7pt "Unsubscribe" footer so every marketing sequence email has a
  // compliance link without the operator having to remember it. The
  // append always runs — it doesn't try to detect an operator-placed
  // inline link, per the operator's "always append" spec.
  const baseUrl = getAppUrl()
  const unsubscribeUrl = buildUnsubscribeUrl(contact, baseUrl)
  const mergedSubject = applyMergeTags(subject, contact)
  const merged = applyMergeTags(html, contact, {
    unsubscribe_url: unsubscribeUrl,
    preference_url: `${baseUrl}/preferences/${unsubscribeUrl.split('/unsubscribe/')[1]}`,
  })
  const mergedHtml = appendUnsubscribeFooter(merged, unsubscribeUrl)

  // Attribution (source_type='sequence', sequence_id, sequence_step_id) is
  // passed in so the email_sends row is inserted WITH it — atomically. The
  // previous follow-up UPDATE keyed on postmark_message_id raced the open/
  // click webhook: a fast webhook could process the row before the UPDATE
  // landed, so the open was never attributed to the step.
  const result = await sendTransactionalEmail({
    to: contact.email,
    subject: mergedSubject,
    htmlBody: mergedHtml,
    contactId: contact.id,
    locationId: sequence.location_id,
    tag: `seq-${sequence.id}`,
    sourceType: 'sequence',
    sequenceId: sequence.id,
    sequenceStepId: step.id,
  })

  // Bump per-step metric.
  // supabase-js builders don't have .catch — try/catch around await.
  try { await db.rpc('increment_step_sent', { p_step_id: step.id }) } catch {}

  return result?.messageId || null
}

// ── whatsapp ────────────────────────────────────────────────────

export async function sendWhatsappStep(db, { step, sequence, contact }) {
  if (!step.whatsapp_template_id) {
    throw new Error('WhatsApp step has no template_id.')
  }
  if (!contact?.wa_phone) {
    throw new Error('Contact has no WhatsApp phone number — cannot send WhatsApp step.')
  }

  // Resolve the template; must be APPROVED to send.
  const { data: template } = await db
    .from('whatsapp_templates')
    .select('*')
    .eq('id', step.whatsapp_template_id)
    .single()
  if (!template) throw new Error('WhatsApp template not found.')
  if (template.status !== 'APPROVED') {
    throw new Error(`WhatsApp template "${template.name}" is ${template.status}, not APPROVED — cannot send.`)
  }
  if (template.location_id !== sequence.location_id) {
    throw new Error('WhatsApp template belongs to a different location than the sequence.')
  }

  // Variable mapping resolution mirrors the broadcasts flow exactly.
  // locationId matters beyond branding: buildTemplateComponents needs it to
  // mint the per-contact flow_token for FLOW-button templates (e.g.
  // book_first_visit) — without it the button component is omitted and Meta
  // rejects the send with (#131009). Proven live by the First Class Booking
  // Nudge, whose WhatsApp step failed while broadcasts sent the same
  // template fine (they always passed locationId).
  const variableMapping = step.whatsapp_variables || {}
  const branding = await getLocationBranding(db, sequence.location_id)
  const components = buildTemplateComponents(
    template,
    contact,
    variableMapping,
    step.whatsapp_header_media_url || null,
    { companyName: branding.companyName, locationId: sequence.location_id },
  )

  const result = await sendTemplateMessage(
    contact.wa_phone,
    template.name,
    template.language,
    components
  )

  // Log to whatsapp_messages so the inbox + analytics see it.
  // Conversation is upserted via the helper to attribute correctly.
  //
  // The inserted row's id is ALSO this step's send id. Handlers MUST return
  // OUR row uuids, never provider ids: sequence_enrollments.last_step_send_id
  // is a uuid column, and returning Meta's "wamid.…" string here made the
  // runner's cursor-advance update fail with 22P02 — silently — so the claim
  // lease expired and the step RE-SENT every ~10 minutes (the live Tim Ivers
  // double-send, 2026-07-02).
  const conversationId = await getOrCreateConversation(db, contact, sequence.location_id)
  let sendRowId = null
  if (conversationId && result?.messageId) {
    const { data: msgRow } = await db.from('whatsapp_messages').insert({
      conversation_id: conversationId,
      contact_id: contact.id,
      location_id: sequence.location_id,
      wa_message_id: result.messageId,
      direction: 'outbound',
      message_type: 'template',
      template_name: template.name,
      template_variables: variableMapping,
      body: renderTemplateBody(template, contact, variableMapping, { companyName: branding.companyName }),
      status: 'sent',
      sent_at: new Date().toISOString(),
    }).select('id').single()
    sendRowId = msgRow?.id || null
  }

  // Bump per-step metric.
  // supabase-js builders don't have .catch — try/catch around await.
  try { await db.rpc('increment_step_sent', { p_step_id: step.id }) } catch {}

  return sendRowId
}

// ── sms (mig 062) ───────────────────────────────────────────────

export async function sendSmsStep(db, { step, sequence, contact }) {
  if (!step.sms_body) {
    throw new Error('SMS step has no sms_body.')
  }
  if (!contact?.phone) {
    throw new Error('Contact has no phone number — cannot send SMS step.')
  }
  // Mirrors the broadcast and ad-hoc send-side gate. Opted-out
  // contacts are silently skipped at the audience layer for
  // broadcasts, but for sequences a contact may have opted out
  // mid-flow. Throwing here causes the standard sequence error
  // path to log + retry / pause the enrollment after MAX_ERRORS.
  if (contact.sms_status && contact.sms_status !== 'active') {
    throw new Error(`Contact's sms_status is '${contact.sms_status}' — refusing to send.`)
  }

  // Resolve the sequence's location so we get the right alpha
  // sender ID (mig 059). Sequences are pinned to one location, so
  // every enrolment in this sequence sends from the same sender.
  const { data: location } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id')
    .eq('id', sequence.location_id)
    .single()
  if (!location) {
    throw new Error('Sequence location not found — cannot resolve SMS sender.')
  }

  // Apply merge tags. Same set as email + ad-hoc SMS (first_name,
  // name, location_name, etc.).
  const renderedBody = applyMergeTags(step.sms_body, contact, {
    location_name: location.name || '',
  })

  let result
  try {
    result = await sendLocationSms({ location, to: contact.phone, body: renderedBody })
  } catch (e) {
    const msg = e instanceof TwilioError
      ? `Twilio ${e.code || e.status || ''}: ${e.message}`.trim()
      : (e?.message || 'SMS send failed')
    throw new Error(msg)
  }

  // Activity timeline entry. Same shape as the broadcast + ad-hoc
  // send paths (type='sms_sent', cyan chip in the contact page's
  // activityIcons map). Its id doubles as the step's send id — a Twilio
  // "SM…" sid is NOT a uuid and would hit the same 22P02 re-send loop
  // the WhatsApp step did (last_step_send_id is a uuid column).
  const { data: activityRow } = await db.from('activities').insert({
    contact_id: contact.id,
    location_id: sequence.location_id,
    type: 'sms_sent',
    subject: `SMS sequence step: ${sequence.name || 'Untitled sequence'}`,
    note: renderedBody,
  }).select('id').single()

  // Bump per-step metric.
  // supabase-js builders don't have .catch — try/catch around await.
  try { await db.rpc('increment_step_sent', { p_step_id: step.id }) } catch {}

  return activityRow?.id || null
}

// ── apply_tag (Tier 1B / mig 087) ───────────────────────────────

/**
 * apply_tag step. Reads config.tag and upserts a contact_tags row
 * for this contact (location-scoped). Idempotent — the partial
 * UNIQUE on (contact_id, tag) WHERE removed_at IS NULL keeps a
 * single active row even if the operator queues the same tag
 * twice in a sequence.
 *
 * Tag string is operator-controlled — no whitelist. Lets operators
 * use the rules-engine tags AND custom tags they invent. Trim +
 * length cap at 60 chars to match contact_tags column.
 */
export async function applyTagStep(db, { step, contact, sequence }) {
  const tag = String(step.config?.tag || '').trim().slice(0, 60)
  if (!tag) throw new Error('apply_tag step: config.tag is required')

  // Re-activate a soft-deleted matching tag if one exists; otherwise
  // insert. The partial UNIQUE prevents concurrent dupes.
  const { data: existing } = await db
    .from('contact_tags')
    .select('id, removed_at')
    .eq('contact_id', contact.id)
    .eq('tag', tag)
    .order('added_at', { ascending: false })
    .limit(1)
  const row = existing?.[0]
  if (row && row.removed_at) {
    await db
      .from('contact_tags')
      .update({ removed_at: null, added_at: new Date().toISOString() })
      .eq('id', row.id)
  } else if (!row) {
    await db.from('contact_tags').insert({
      contact_id: contact.id,
      location_id: sequence?.location_id || contact.location_id,
      tag,
    })
  }
  // Active row already exists → no-op.
}

// ── update_field (Tier 1B / mig 087) ────────────────────────────

/**
 * update_field step. Whitelisted fields only — operators can't
 * stamp arbitrary columns. Currently allows 'label' only.
 *
 * CLASSIFY.2: lead_status was removed from the whitelist. To move
 * a contact between pipeline stages use the move_pipeline_stage
 * step type instead — pipeline_stage_slug is trigger-derived from
 * deals.stage_id and must not be written directly by app code.
 */
export async function updateFieldStep(db, { step, contact }) {
  const WHITELIST = new Set(['label'])
  const field = String(step.config?.field || '').trim()
  const value = step.config?.value
  if (!WHITELIST.has(field)) {
    throw new Error(`update_field step: field "${field}" is not allowed (whitelist: ${[...WHITELIST].join(', ')})`)
  }
  if (typeof value !== 'string' && value !== null) {
    throw new Error('update_field step: value must be a string or null')
  }

  const oldValue = contact[field]
  if (oldValue === value) return // no-op

  await db.from('contacts').update({ [field]: value }).eq('id', contact.id)
}

// ── branch (Tier 3E / mig 091) ──────────────────────────────────
//
// A branch step doesn't send anything — it picks one of two
// continuation points based on a predicate over the contact, and
// returns the chosen step_order. The runner uses that to advance
// the enrolment cursor.
//
// Predicate types:
//   - has_tag         { tag }           — contact has the active tag
//   - field_equals    { field, value }  — contact[field] === value
//   - field_in        { field, values } — contact[field] is in the list
//
// Allowed fields mirror update_field's whitelist plus a couple of
// read-only ones that operators commonly want to fork on. Anything
// outside the allow-list throws so a malicious config can't be used
// to probe arbitrary contact columns via the predicate.
//
// Pointer defaults: when then_step_order or else_step_order are
// missing/invalid, default to "step_order + 1" for then (proceed
// normally) and "step_order + 2" for else (skip the next step).
// This makes the simplest branch — "send follow-up if matched, skip
// it otherwise" — a one-line config: { predicate }.
//
// Loop guard: the runner refuses to jump backwards. then_step_order
// or else_step_order must be > the branch's own step_order. This
// rules out infinite loops while we don't have a per-enrolment loop
// counter; revisit if real loop patterns show up.
const BRANCH_FIELD_WHITELIST = new Set([
  'pipeline_stage_slug',
  'label',
  'email_status',
  'sms_status',
  'marketing_opt_in',
])

export async function evaluateBranchPredicate(db, { contact, predicate }) {
  if (!predicate || typeof predicate !== 'object') {
    throw new Error('branch step: config.predicate is required')
  }
  const type = String(predicate.type || '').trim()

  if (type === 'has_tag') {
    const tag = String(predicate.tag || '').trim()
    if (!tag) throw new Error('branch has_tag: tag is required')
    const { data, error } = await db
      .from('contact_tags')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('tag', tag)
      .is('removed_at', null)
      .limit(1)
    if (error) throw new Error(`branch has_tag: ${error.message}`)
    return Boolean(data && data.length > 0)
  }

  if (type === 'field_equals') {
    const field = String(predicate.field || '').trim()
    if (!BRANCH_FIELD_WHITELIST.has(field)) {
      throw new Error(`branch field_equals: field "${field}" is not allowed`)
    }
    return contact[field] === predicate.value
  }

  if (type === 'field_in') {
    const field = String(predicate.field || '').trim()
    if (!BRANCH_FIELD_WHITELIST.has(field)) {
      throw new Error(`branch field_in: field "${field}" is not allowed`)
    }
    const values = Array.isArray(predicate.values) ? predicate.values : []
    if (values.length === 0) {
      throw new Error('branch field_in: values must be a non-empty array')
    }
    return values.includes(contact[field])
  }

  throw new Error(`branch step: unknown predicate type "${type}"`)
}

/**
 * Resolve where the runner should land next after evaluating a
 * branch step. Returns the chosen step_order (always > the branch's
 * own step_order). Falls back to sensible defaults when the config
 * doesn't specify a pointer.
 */
export async function processBranchStep(db, { step, contact }) {
  const cfg = step.config || {}
  const branchOrder = step.step_order
  const matched = await evaluateBranchPredicate(db, {
    contact,
    predicate: cfg.predicate,
  })
  const rawTarget = matched ? cfg.then_step_order : cfg.else_step_order
  const fallback = matched ? branchOrder + 1 : branchOrder + 2
  const target = Number.isInteger(rawTarget) ? rawTarget : fallback
  if (target <= branchOrder) {
    throw new Error(
      `branch step: target step_order (${target}) must be greater than the branch's own step_order (${branchOrder}); refusing to loop backwards`,
    )
  }
  return target
}

// ── webhook (Tier 2C / mig 089) ─────────────────────────────────

/**
 * webhook step. POSTs (or other method) to a configured URL with
 * contact context. config:
 *   - url            (required, must be HTTPS)
 *   - method         (default POST)
 *   - headers        (record<string,string>, optional)
 *   - payload        (object, optional — defaults to a sensible
 *                     contact + sequence summary)
 *
 * No retry beyond what the runner already does (5 fails → pause).
 * Operators can build on top with a wait-step + condition step
 * if they need fancier logic.
 *
 * Security: URL must start with https:// to prevent accidental
 * plain-HTTP exfil. No HMAC signing in v1 — operators should use
 * a per-endpoint API key in the headers if they need it.
 */
export async function webhookStep(_db, { step, contact, sequence, enrollment }) {
  const cfg = step.config || {}
  const url = String(cfg.url || '').trim()
  if (!url) throw new Error('webhook step: config.url is required')
  if (!url.startsWith('https://')) {
    throw new Error('webhook step: url must start with https:// for security')
  }
  const method = String(cfg.method || 'POST').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error(`webhook step: method "${method}" not supported`)
  }

  // Default payload: contact + sequence + enrolment context. Operators
  // can override by setting cfg.payload — anything serialisable goes.
  const defaultPayload = {
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      pipeline_stage_slug: contact.pipeline_stage_slug,
      location_id: contact.location_id,
    },
    sequence: {
      id: sequence.id,
      name: sequence.name,
    },
    enrolment: {
      id: enrollment.id,
      step_order: step.step_order,
    },
    fired_at: new Date().toISOString(),
  }
  const payload = cfg.payload && typeof cfg.payload === 'object'
    ? cfg.payload
    : defaultPayload

  const headers = {
    'content-type': 'application/json',
    'user-agent': 'un1t-sequences-webhook/1.0',
    ...(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}),
  }
  const body = method === 'GET' ? undefined : JSON.stringify(payload)

  let res
  try {
    res = await fetch(url, { method, headers, body })
  } catch (e) {
    throw new Error(`webhook fetch failed: ${e.message || e}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`webhook returned ${res.status}: ${text.slice(0, 200)}`)
  }
}

// ── internal_task ───────────────────────────────────────────────

/**
 * internal_task step. Creates an activity row (kind='task') so it
 * shows up on the contact's open-tasks list + the staff's task
 * inbox. Config: subject, note, assignee_user_id (optional),
 * assignee_role (optional, e.g. 'manager').
 *
 * If assignee_user_id is provided, it's set directly. Otherwise
 * the assignee is left null — operators can pick it up from the
 * /activities queue. assignee_role is informational; we don't
 * fan-out to multiple users.
 */
export async function internalTaskStep(db, { step, contact, sequence }) {
  const cfg = step.config || {}
  const subject = String(cfg.subject || '').trim().slice(0, 200)
  const note = String(cfg.note || '').trim().slice(0, 4000)
  if (!subject) throw new Error('internal_task step: config.subject is required')

  const dueOffsetMinutes = Number.isFinite(cfg.due_offset_minutes)
    ? cfg.due_offset_minutes
    : 0
  const dueAt = new Date(Date.now() + Math.max(0, dueOffsetMinutes) * 60_000).toISOString()

  await db.from('activities').insert({
    contact_id: contact.id,
    location_id: sequence?.location_id || contact.location_id,
    type: 'task',
    kind: 'task',
    subject,
    note: note || null,
    assigned_to: cfg.assignee_user_id || null,
    due_at: dueAt,
  })
}

// ── move_pipeline_stage (GLOFOX4.3) ──────────────────────────────
//
// Lets a sequence push a contact's open deal to a target pipeline
// stage as part of an automated flow. Use case: "trial member has
// attended 2 classes → move them to Conversion Ready AND email
// them about membership". Pairs cleanly with the trial-transition
// tags (GLOFOX4.2) on the trigger side.
//
// Config:
//   stage_slug (required) — the target pipeline_stages.slug at the
//                            sequence's location (e.g. 'conversion_ready')
//
// Semantics:
//   - No open deal → no-op (logged on the timeline as an info entry)
//   - Already at target stage → no-op (logged)
//   - Otherwise → UPDATE deals.stage_id AND log activity row
//                 ("Pipeline: trial_active → conversion_ready ·
//                  via sequence 'X'") so the operator can audit why.
//
// Idempotent — running the step twice with the same target is a
// no-op the second time (the already-at-target branch).
export async function movePipelineStageStep(db, { step, contact, sequence }) {
  const cfg = step.config || {}
  const targetSlug = String(cfg.stage_slug || '').trim()
  if (!targetSlug) {
    throw new Error('move_pipeline_stage step: config.stage_slug is required')
  }

  // Lazy import to avoid a top-level circular dep — sequences/steps
  // is imported transitively by glofox-sync via the trigger module
  // (status_change cascade in updateFieldStep), and glofox-sync
  // owns these helpers.
  const { getOpenDealWithStage, findStageIdBySlug } = await import('../glofox-sync.js')

  const locationId = sequence?.location_id || contact.location_id
  const existing = await getOpenDealWithStage(db, contact.id)

  const seqLabel = sequence?.name ? `sequence "${sequence.name}"` : 'sequence'

  if (!existing) {
    // No open deal to move — log + continue. Don't throw: the
    // sequence might also have an email step that's still useful
    // for a contact without a pipeline entry yet.
    await db.from('activities').insert({
      contact_id: contact.id,
      location_id: locationId,
      kind: 'event',
      type: 'pipeline',
      subject: `Pipeline move skipped (no open deal) — via ${seqLabel}`,
      note: `Target stage was '${targetSlug}'. Sequence proceeded; no deal was modified.`,
      done: false,
    })
    return
  }

  if (existing.stage_slug === targetSlug) {
    // Already at target — log a no-op so the operator sees the
    // sequence actually executed this step (vs. silently skipping).
    await db.from('activities').insert({
      contact_id: contact.id,
      location_id: locationId,
      kind: 'event',
      type: 'pipeline',
      subject: `Pipeline already at ${targetSlug} — via ${seqLabel}`,
      note: 'No move required; deal was already at the target stage.',
      done: false,
    })
    return
  }

  const targetStageId = await findStageIdBySlug(db, locationId, targetSlug)
  if (!targetStageId) {
    throw new Error(`move_pipeline_stage step: target stage '${targetSlug}' not found at this location`)
  }

  const { error: moveErr } = await db
    .from('deals')
    .update({ stage_id: targetStageId })
    .eq('id', existing.id)
  if (moveErr) {
    throw new Error(`move_pipeline_stage step: ${moveErr.message}`)
  }

  // Audit row on the contact timeline — same shape as
  // logPipelineEvent's CRM-side moves so the activity feed
  // surfaces both in one consistent format.
  await db.from('activities').insert({
    contact_id: contact.id,
    location_id: locationId,
    kind: 'event',
    type: 'pipeline',
    subject: `Pipeline: ${existing.stage_slug} → ${targetSlug}`,
    note: `Moved by ${seqLabel}.`,
    done: false,
  })
}

// ── glofox_provision (AUTOMATIONS Phase 1) ───────────────────────
//
// Operational action: create the contact's Glofox account + attach the
// studio trial as a step in an automation flow. Wraps the vetted
// findOrCreateGlofoxMember create-and-trial primitive — idempotent
// (links by email if the member already exists), audited to
// glofox_push_events (source='automation'), and never-throws on a
// per-contact data problem (missing name / no Glofox creds → a 'failed'
// status that surfaces in the Glofox Review queue, NOT a runner error).
//
// Config: none — uses the location's settings.glofox trial config.
// `_findOrCreateGlofoxMember` is a test seam; production resolves the
// real helper via dynamic import (mirrors movePipelineStageStep).
export async function glofoxProvisionStep(db, { contact, sequence, _findOrCreateGlofoxMember }) {
  const findOrCreate = _findOrCreateGlofoxMember
    || (await import('../glofox-push.js')).findOrCreateGlofoxMember
  const locationId = sequence?.location_id || contact.location_id
  await findOrCreate({
    db,
    locationId,
    contact,
    source: 'automation',
    createIfMissing: true,
    attachTrial: true,
  })
}
