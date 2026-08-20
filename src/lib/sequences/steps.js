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
  sendMarketingEmail,
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
import { logWarn } from '@/lib/log'
import { signStartPrefillToken } from '@/lib/start-prefill-token'
import { getLocationBranding } from '@/lib/location-branding'
import { isFrequencyCapped, frequencyCapDeferUntil, FrequencyCapDeferral, stampMarketingTouch } from '@/lib/frequency-cap'
import { overlayConnections } from '@/lib/connection-registry'
import { isFeatureEnabledAtLocation } from '@shared/permissions'

// ── FREQ-CAP.1 — cross-channel marketing frequency cap ──────────
//
// The email + WhatsApp send handlers receive the sequence location's
// normalised cap setting as ctx.frequencyCap (resolved + cached per
// tick by the scheduler). When the contact is inside the window the
// handler throws FrequencyCapDeferral BEFORE any provider call; the
// scheduler catches it specifically and pushes next_step_at to the
// window-clear time (+ jitter) WITHOUT touching error_count or the
// cursor — the step is DEFERRED, never skipped, and because nothing
// was sent a deferral can never create a re-send loop.
//
// Order of gates: the cap check runs AFTER the per-contact consent/
// hygiene gates above it — a suppressed contact is a recorded skip
// (excluded anyway) and must be neither deferred nor stamped.
//
// SMS steps are deliberately NOT gated or stamped in this slice (the
// cap covers email + WhatsApp, the two channels campaigns/broadcasts
// share) — extend here if SMS marketing volume ever warrants it.
// LOCCOMMS.5 — resolve the contact's consent row for the SEQUENCE'S location.
//
// Sequences do not go through buildAudienceQuery, so the PR 3 cutover missed
// them and they were still gating on the denormalised global column. That was
// wrong in both directions: someone opted out globally but opted IN here was
// wrongly skipped, and someone opted in globally but opted OUT here was wrongly
// sent to — the harm this programme exists to prevent.
//
// Returns null when there is no row for that location, and callers treat null
// as "do not send". That matches the INNER join in contact_location_audience,
// so the broadcast and sequence paths agree: row absent = that location may
// never send to this person.
function locationConsent(contact, sequence) {
  const rows = contact?.contact_location_preferences || []
  const locId = sequence?.location_id
  if (!locId) return null
  return rows.find((r) => r.location_id === locId) || null
}

function assertNotFrequencyCapped(contact, frequencyCap) {
  if (frequencyCap?.enabled && isFrequencyCapped(contact, frequencyCap)) {
    throw new FrequencyCapDeferral(frequencyCapDeferUntil(contact, frequencyCap))
  }
}

// ── recorded skips (COMMS-AUDIT 2026-07-10, SEQ batch) ──────────
//
// A send step that CANNOT legitimately go to this contact — no
// number/consent on file, or a channel status of opted_out/blocked/
// undeliverable/bounced — is a per-CONTACT condition, not a sequence
// fault. Throwing routed it to the runner's error path: error_count
// climbed and after MAX_ERRORS the whole enrolment auto-PAUSED
// (live 2026-07-10: 11 of 17 enrollments of "New Lead – First Class
// Booking Nudge" wedged on "Contact has no WhatsApp phone number").
//
// Instead the handler records WHY on the contact's timeline
// (best-effort, the movePipelineStageStep retired-step idiom) and
// resolves null. The scheduler treats a null send id exactly like a
// wait step: ONE cursor-advance update through the normal path, so
// the throw-on-advance-failure discipline (the 22P02 re-send-loop
// incident class) is untouched and a skipped step is never retried.
//
// Sequence-CONFIG faults (missing/unapproved template, no body, no
// location) still throw — those need an operator fix, and the
// error-then-pause path is how they surface.
async function recordStepSkip(db, { contact, sequence, step, channel, reason }) {
  try {
    await db.from('activities').insert({
      contact_id: contact.id,
      location_id: sequence?.location_id || contact.location_id,
      kind: 'event',
      type: 'note',
      subject: `Sequence ${channel} step skipped — ${reason}`,
      note: `Step ${step?.step_order ?? '?'} of sequence "${sequence?.name || 'Untitled sequence'}" was not sent (${reason}). The enrolment advanced to the next step normally.`,
      done: false,
    })
  } catch { /* best-effort logging only — never wedge the runner */ }
}

// ── TENANT.8 (item 3b) — location bundle/feature gate ───────────
//
// TENANT.6's accepted gap #2: background senders never consulted
// isFeatureEnabledAtLocation/bundlesDenyKey at all, so a sequence
// configured before a location's bundle_marketing/bundle_messaging
// (or the plain per-key email/whatsapp/sms toggle) was turned off
// kept firing regardless. Closed here: every send handler fetches its
// sequence's location (features column) and gates through the SAME
// resolver web/mobile already use — isFeatureEnabledAtLocation ANDs
// the per-key toggle with the bundle layer's OR-across-owning-bundles
// check (shared/permission-bundles.js) automatically, so no new bundle
// logic lives in this file at all.
//
// Each handler fetches its own `locations` row (columns vary — email/sms
// already fetched one for name/sender-id before this change, this just
// adds `features` to that same select; WhatsApp did not previously fetch
// `locations` at all, so its gate call below is a genuinely NEW query —
// accepted, a sequence tick fires a handful of steps, not a fan-out) and
// passes it to channelEnabledOrSkip below.
//
// Missing/undeleted location info defaults OPEN (isFeatureEnabledAtLocation's
// own contract — `location == null` → features = {} → nothing denied),
// matching the "don't block on missing data" posture every other
// call site of this resolver takes.
async function channelEnabledOrSkip(db, { location, sequence, step, contact, channel, featureKey }) {
  if (isFeatureEnabledAtLocation(location, featureKey)) return true
  await recordStepSkip(db, {
    contact, sequence, step, channel,
    reason: `${featureKey} is disabled at this location (feature toggle or bundle off)`,
  })
  return false
}

// ── email ───────────────────────────────────────────────────────

export async function sendEmailStep(db, { enrollment: _enrollment, step, sequence, contact, frequencyCap }) {
  if (!contact?.email) {
    throw new Error('Contact has no email address — cannot send email step.')
  }

  // TENANT.8 (item 3b) — location bundle/feature gate, before any other
  // per-contact work. One query serves both this gate AND the
  // {{location_name}} merge-tag lookup further down (COMMSFIX.E.4) —
  // no extra round trip versus before this change.
  const { data: seqLocation } = await db
    .from('locations')
    .select('id, name, features')
    .eq('id', sequence.location_id)
    .single()
  if (!(await channelEnabledOrSkip(db, {
    location: seqLocation, sequence, step, contact, channel: 'email', featureKey: 'email',
  }))) {
    return null
  }
  const locationName = seqLocation?.name || ''

  // Send-time consent gate — the same population campaign broadcasts
  // enforce (campaign-sender consentOk: email_marketing === true AND
  // email_status not bounced/complained; we also refuse a manually
  // stamped 'unsubscribed' as belt-and-braces — the unsubscribe page
  // normally flips email_marketing false via trigger). Without it an
  // active sequence keeps emailing a contact who has since
  // unsubscribed/bounced/complained (Postmark reputation + GDPR).
  // A consent-blocked contact is a recorded SKIP, not an error —
  // mid-sequence unsubscribes are normal contact behaviour, and the
  // error path pauses the whole enrolment after MAX_ERRORS (see
  // recordStepSkip).
  const emailConsent = locationConsent(contact, sequence)
  if (emailConsent?.email_marketing !== true) {
    await recordStepSkip(db, {
      contact, sequence, step, channel: 'email',
      reason: emailConsent
        ? 'no email marketing consent for this location'
        : 'not on this location\u2019s list',
    })
    return null
  }
  // LOCCOMMS.5 / mig 492 — 'unsubscribed' deliberately absent: the value is
  // retired (mig 501 CHECK), consent is the per-location gate above.
  if (contact.email_status && ['bounced', 'complained'].includes(contact.email_status)) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'email', reason: `email_status is '${contact.email_status}'` })
    return null
  }
  // NOENGSUP.1 — marketing-suppressed contacts are a recorded SKIP, mirroring
  // the campaign audience gate in buildAudienceQuery. This used to catch
  // 90-day non-openers too; that rule is retired (mig 537), so the only stamps
  // left are REPEAT-BOUNCE suppressions, each with an email_bounce_escalations
  // row behind it. Still reversible: a genuine open/click clears the stamp, as
  // does an operator release from the list-health page.
  if (contact.email_suppressed_at) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'email', reason: 'suppressed for repeat bounces' })
    return null
  }
  // FREQ-CAP.1 — after every consent/hygiene gate, before any send work.
  // Throws FrequencyCapDeferral (deferred, not skipped — see module header).
  assertNotFrequencyCapped(contact, frequencyCap)

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
  // append is idempotent — if the merged body already contains the
  // unsubscribe link, appendUnsubscribeFooter skips it so recipients
  // don't see two "Unsubscribe" links.
  // COMMSFIX.E.4 — {{location_name}} renders in sequence EMAIL steps as
  // it already does in SMS steps (six shipped templates sign off 'UN1T
  // {{location_name}}'; without it rendered 'UN1T ' with a trailing
  // space). locationName is resolved above from the same location row
  // the bundle gate fetched.
  const baseUrl = getAppUrl()
  const unsubscribeUrl = buildUnsubscribeUrl(contact, baseUrl, sequence?.location_id)
  // UNSUBTOKEN.2 — null means the contact has no
  // contact_preferences.unsubscribe_token, and a sequence step is MARKETING
  // mail (it rides the broadcast stream via sendMarketingEmail, headers and
  // all). Without a token there is no unsubscribe link and no List-Unsubscribe
  // header that can resolve — buildUnsubscribeUrl used to hand back
  // /unsubscribe/<contact.id>, which the token-only API always 404s.
  //
  // A recorded SKIP, not a throw: this is a per-CONTACT fault, and the
  // 2026-07-10 incident (11 of 17 enrolments wedged on "no WhatsApp phone
  // number") is what happens when a per-contact fault feeds error_count until
  // MAX_ERRORS pauses the enrolment for everybody on it. The activity row names
  // the reason on the contact's timeline; mig 532 means nobody is in this state
  // today, so one appearing is a real signal worth reading.
  if (!unsubscribeUrl) {
    await recordStepSkip(db, {
      contact, sequence, step, channel: 'email',
      reason: 'no unsubscribe token — a marketing email needs a working opt-out link',
    })
    return null
  }
  // STARTPREFILL.1 — minted per send, so every email carries a fresh token and
  // the TTL is measured from when THAT email went out rather than from an
  // enrolment weeks earlier. Best-effort: a signing failure (an unset secret in
  // some environment) must lose the prefill, never the email.
  let bookingToken = ''
  try {
    bookingToken = signStartPrefillToken({ contactId: contact.id })
  } catch (e) {
    logWarn('sequences', `booking token not minted for ${contact.id}: ${e.message || e}`, { contactId: contact.id })
  }

  const mergedSubject = applyMergeTags(subject, contact, { location_name: locationName })
  const merged = applyMergeTags(html, contact, {
    location_name: locationName,
    booking_token: bookingToken,
    unsubscribe_url: unsubscribeUrl,
    // Derived from the unsubscribe URL because both endpoints resolve the same
    // token column. Safe to split now that the null case returned above.
    preference_url: `${baseUrl}/preferences/${unsubscribeUrl.split('/unsubscribe/')[1]}`,
  })
  const mergedHtml = appendUnsubscribeFooter(merged, unsubscribeUrl)

  // Attribution (source_type='sequence', sequence_id, sequence_step_id) is
  // passed in so the email_sends row is inserted WITH it — atomically. The
  // previous follow-up UPDATE keyed on postmark_message_id raced the open/
  // click webhook: a fast webhook could process the row before the UPDATE
  // landed, so the open was never attributed to the step.
  //
  // COMMS-AUDIT 2026-07-10: sequence step emails are MARKETING mail and
  // ride Postmark's broadcast stream via sendMarketingEmail (previously
  // sendTransactionalEmail → 'outbound', which never attached the RFC
  // 8058 List-Unsubscribe one-click headers). unsubscribeUrl is passed
  // through so sendEmail adds those headers alongside the visible footer.
  // SEQSENDER.1 (mig 555) — a sequence may name its own sender. Built here the
  // same way campaign-sender.js builds a campaign's, because the application
  // owns the display name: Postmark does not stamp a signature's name onto a
  // bare address. from_email NULL (every pre-existing sequence) → undefined →
  // the global POSTMARK_FROM_EMAIL default, unchanged.
  const sequenceFrom = sequence.from_email
    ? (sequence.from_name ? `${sequence.from_name} <${sequence.from_email}>` : sequence.from_email)
    : undefined

  const result = await sendMarketingEmail({
    to: contact.email,
    subject: mergedSubject,
    htmlBody: mergedHtml,
    contactId: contact.id,
    locationId: sequence.location_id,
    tag: `seq-${sequence.id}`,
    unsubscribeUrl,
    from: sequenceFrom,
    // NULL keeps EMAIL-INBOX.1's default (the location's unified-inbox address).
    replyTo: sequence.reply_to || undefined,
    sourceType: 'sequence',
    sequenceId: sequence.id,
    sequenceStepId: step.id,
  })

  // FREQ-CAP.1 — marketing-touch stamp after the successful send (best-
  // effort in the helper; stamped even while the cap is disabled).
  await stampMarketingTouch(db, [contact.id])

  // Bump per-step metric.
  // supabase-js builders don't have .catch — try/catch around await.
  try { await db.rpc('increment_step_sent', { p_step_id: step.id }) } catch {}

  return result?.messageId || null
}

// ── whatsapp ────────────────────────────────────────────────────

export async function sendWhatsappStep(db, { step, sequence, contact, frequencyCap }) {
  if (!step.whatsapp_template_id) {
    throw new Error('WhatsApp step has no template_id.')
  }

  // TENANT.8 (item 3b) — location bundle/feature gate, before any other
  // per-contact work. Unlike email/SMS, no `locations` row was
  // previously fetched here (getLocationBranding reads company_settings,
  // a different table) — this is a genuinely new query per step
  // execution. Accepted: a sequence tick fires a handful of steps, not
  // a fan-out, so the extra round trip is worth closing the RLS-bypass
  // gap on a service-role sender.
  const { data: waLocation } = await db
    .from('locations')
    .select('id, features')
    .eq('id', sequence.location_id)
    .single()
  if (!(await channelEnabledOrSkip(db, {
    location: waLocation, sequence, step, contact, channel: 'WhatsApp', featureKey: 'whatsapp',
  }))) {
    return null
  }

  // Per-contact gates — recorded SKIPS, never errors (see recordStepSkip;
  // the throw here is what auto-paused 11 of 17 live "First Class Booking
  // Nudge" enrollments on contacts with no wa_phone).
  if (!contact?.wa_phone) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'WhatsApp', reason: 'contact has no WhatsApp phone number' })
    return null
  }
  // Send-time consent gate — mirrors the SMS step and the broadcast
  // reachability predicate (applyWhatsAppReachability in
  // src/lib/whatsapp.js, post mig 422: whatsapp_marketing is
  // denormalised onto contacts): opted into WA marketing AND not
  // opted_out/blocked/undeliverable. Broadcasts filter this at the
  // audience layer; a sequence contact can text STOP mid-flow, so the
  // gate must run at SEND time — that contact must never receive
  // another WA step.
  const waConsent = locationConsent(contact, sequence)
  if (waConsent?.whatsapp_marketing !== true) {
    await recordStepSkip(db, {
      contact, sequence, step, channel: 'WhatsApp',
      reason: waConsent
        ? 'no WhatsApp marketing consent for this location'
        : 'not on this location\u2019s list',
    })
    return null
  }
  if (['opted_out', 'blocked', 'undeliverable'].includes(contact.wa_status)) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'WhatsApp', reason: `wa_status is '${contact.wa_status}'` })
    return null
  }
  // FREQ-CAP.1 — after every consent gate, before any send work. Throws
  // FrequencyCapDeferral (deferred, not skipped — see module header).
  assertNotFrequencyCapped(contact, frequencyCap)

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

  // COMMS-AUDIT 2026-07-10: route from the sequence location's
  // whatsapp_numbers row. Without { locationId } config resolution
  // falls back to env vars — the wrong sender for any location that
  // isn't the env default, and a dead send if the env token has
  // rotted. The sequence's location is authoritative here (same as
  // broadcasts, which pass broadcast.location_id): the template,
  // branding, flow_token and conversation above are all already
  // resolved against sequence.location_id.
  const result = await sendTemplateMessage(
    contact.wa_phone,
    template.name,
    template.language,
    components,
    { locationId: sequence.location_id },
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
    const { data: msgRow, error: msgErr } = await db.from('whatsapp_messages').insert({
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
    // SINGLEERR.1 — this row's id IS the step's send id (see above), so a
    // rejected insert silently returns null and the runner advances its cursor
    // with no send to point at. Best-effort — the WhatsApp message HAS gone out,
    // so we must not throw — but never silent.
    if (msgErr) {
      logWarn('sequences', 'whatsapp_messages insert failed after a successful send', {
        err: msgErr.message, stepId: step.id, contactId: contact.id,
      })
    }
    sendRowId = msgRow?.id || null
  }

  // FREQ-CAP.1 — marketing-touch stamp after the successful send (best-
  // effort in the helper; stamped even while the cap is disabled).
  await stampMarketingTouch(db, [contact.id])

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

  // Resolve the sequence's location up front — needed both for the
  // TENANT.8 (item 3b) bundle/feature gate below AND (already, before
  // this change) the alpha sender ID (mig 059). Sequences are pinned
  // to one location, so every enrolment in this sequence sends from
  // the same sender. Config fault (no location row at all) still
  // throws — that needs an operator fix, unlike a per-contact skip.
  let { data: smsLocation } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id, features')
    .eq('id', sequence.location_id)
    .single()
  if (!smsLocation) {
    throw new Error('Sequence location not found — cannot resolve SMS sender.')
  }
  if (!(await channelEnabledOrSkip(db, {
    location: smsLocation, sequence, step, contact, channel: 'SMS', featureKey: 'sms',
  }))) {
    return null
  }

  // Per-contact gates — recorded SKIPS, never errors (COMMSFIX.E.1).
  // These used to THROW, feeding error_count until MAX_ERRORS auto-
  // paused the whole enrolment — the identical wedge class fixed for
  // email/WA after the live 2026-07-10 incident (see recordStepSkip).
  if (!contact?.phone) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'SMS', reason: 'contact has no phone number' })
    return null
  }
  // Send-time consent gate — the per-location model every other send
  // path already enforces (LOCCOMMS.5): resolve the row for the
  // SEQUENCE'S location; row absent = that location may never send.
  // sendSmsStep was the last step still bypassing it (it only read
  // the global sms_status), so a contact who opted out of SMS
  // marketing for this location via the preference centre still got
  // dunning SMS — the exact consent breach this programme prevents.
  const smsConsent = locationConsent(contact, sequence)
  if (smsConsent?.sms_marketing !== true) {
    await recordStepSkip(db, {
      contact, sequence, step, channel: 'SMS',
      reason: smsConsent
        ? 'no SMS marketing consent for this location'
        : 'not on this location’s list',
    })
    return null
  }
  // Global channel-status gate (STOP replies, carrier invalidation).
  // Mirrors the broadcast reachability predicate; absent = active
  // (back-compat for pre-mig-059 contacts).
  if (contact.sms_status && contact.sms_status !== 'active') {
    await recordStepSkip(db, { contact, sequence, step, channel: 'SMS', reason: `sms_status is '${contact.sms_status}'` })
    return null
  }

  // INTEG-A2 dual-read: registry twilio_sender row first. Reuses the
  // location row fetched above for the bundle gate.
  const location = await overlayConnections(db, smsLocation, ['twilio_sender'])

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
  const { data: activityRow, error: activityErr } = await db.from('activities').insert({
    contact_id: contact.id,
    location_id: sequence.location_id,
    type: 'sms_sent',
    subject: `SMS sequence step: ${sequence.name || 'Untitled sequence'}`,
    note: renderedBody,
  }).select('id').single()
  // SINGLEERR.1 — same as the WhatsApp step: this id doubles as the step's send
  // id, so a rejected insert returned null and said nothing. The SMS is already
  // out, so log rather than throw.
  if (activityErr) {
    logWarn('sequences', 'sms activity insert failed after a successful send', {
      err: activityErr.message, stepId: step.id, contactId: contact.id,
    })
  }

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
 * CLASSIFY.2: lead_status was removed from the whitelist.
 * FUNNEL.1: pipeline stages are classifier-derived and cannot be
 * moved by sequences at all (the move_pipeline_stage step type was
 * retired) — pipeline_stage_slug / deals.stage_id must never be
 * written by sequence code.
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

// ── move_pipeline_stage (GLOFOX4.3 — RETIRED, FUNNEL.1) ──────────
//
// Stage placement is classifier-derived (webhook + nightly cron); a
// sequence step writing deals.stage_id fights the classifier and is
// silently reverted by the next sync, so the step type was retired.
// The builder palette + AI vocabulary no longer offer it; this
// handler exists only for legacy step rows still on disk (at
// retirement: two never-executed drafts targeting the extinct
// 'conversion_ready' slug).
//
// It MUST resolve without throwing and MUST NOT write deals.stage_id.
// The runner treats a thrown handler as a failed advance, and a step
// that can never succeed wedges the enrolment on the same step
// forever — exactly the failed-advance send-LOOP incident
// (SEQ-LOOP-FIX: WhatsApp/SMS steps re-sent every ~10 min). A legacy
// row must advance PAST this step, never retry it.
export async function movePipelineStageStep(db, { step, contact, sequence }) {
  const seqLabel = sequence?.name ? `sequence "${sequence.name}"` : 'sequence'
  const targetSlug = String(step?.config?.stage_slug || '').trim() || '(unset)'

  // Timeline entry — this handler's existing no-op logging idiom — so
  // an operator auditing the enrolment sees the step executed and why
  // nothing moved. Best-effort: a logging failure must never block
  // the advance (see the incident note above).
  try {
    await db.from('activities').insert({
      contact_id: contact.id,
      location_id: sequence?.location_id || contact.location_id,
      kind: 'event',
      type: 'pipeline',
      subject: 'move_pipeline_stage retired (FUNNEL.1) — stage is classifier-derived; step skipped',
      note: `Target stage was '${targetSlug}' — via ${seqLabel}. No deal was modified.`,
      done: false,
    })
  } catch { /* best-effort logging only — never wedge the runner */ }
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
// real helper via dynamic import (avoids a top-level circular dep
// with the glofox modules).
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
