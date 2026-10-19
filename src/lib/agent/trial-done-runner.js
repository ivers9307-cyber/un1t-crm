// TRIALDONE.4 — the trial-done outreach runner (spec:
// docs/superpowers/specs/2026-10-19-hatch-trial-done-conversion-design.md).
//
// Rides the agent-followups cron (every 15 min). Per tick, for every active
// studio whose membership source is un1t.online, whose
// customer_agent.trial_done.enabled is true (a studio-only key, default off)
// and whose Mia is on (enabled, or test_mode):
//
//   1. the studio's proactive window (09:00-19:59 on its own clock, outside
//      its quiet hours), a number switched on there, and its daily cap;
//   2. the open deals in the trial_done column of its enabled acquisition_un1t
//      board (deals, not contacts.pipeline_stage_slug: a deal reaches a
//      shared contact whose home studio is another one, SHAREDCONTACT.1);
//   3. ONE pipelineInputs read: the trigger (trialDoneEvidenceAt) and the
//      board's classification now, per person;
//   4. one trial_done_outreach row per person per studio, once ever
//      (insert ... on conflict do nothing);
//   5. openerDecision: due 2 h after the trigger, closed 'stale' after 24 h;
//   6. eligibility read FRESH before the send (eligibilityVerdict): bought,
//      active member at another studio, staff, no longer trial_done, opted
//      out, no consent at THIS studio. Not eligible closes the row. A failed
//      read is a skip this tick, never "eligible" and never a close;
//   7. the studio's marketing frequency cap defers (row stays open);
//   8. the opener template must be APPROVED at the studio (else a skip: the
//      row stays open and nothing is claimed);
//   9. claim (lease TRIAL_DONE_CLAIM_LEASE_MS), send, record.
//
// Every skip is a counted reason (results.reasons), carried on the cron
// heartbeat. Never throws for one person or one studio. The follow-up stage
// (TRIALDONE.5) is a second stage per row: see processCandidate.

import { DEFAULTS } from './settings-contract'
import { resolveAgentSettingsForLocation } from './settings-resolve'
import {
  proactiveWindowOpen, buildFollowupComponents, renderFollowupBody,
  recordProactiveMessage, studioOwnsWhatsAppNumber,
} from './followups'
import { phoneMatchesAllowlist } from './core'
import { openerDecision, eligibilityVerdict, TRIAL_DONE_CLAIM_LEASE_MS } from './trial-done'
import { classify as classifyUn1t } from '@shared/pipelines/acquisition-un1t'
import { trialDoneEvidenceAt } from '@/lib/membership/reads/un1t-pipeline-dates'
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { loadActiveElsewhere } from '@/lib/pipeline-other-studio-members'
import { isFrequencyCapped, getLocationFrequencyCap, stampMarketingTouch } from '@/lib/frequency-cap'
import { getLocationZones, LocationZoneReadError, dayStrIn, dayStartMsIn } from '@/lib/location-time'
import { escapeLikePattern } from '@/lib/like-escape'
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { isWhatsAppNumberMissing } from '@/lib/whatsapp-number-missing'
import { logError, logWarn } from '@/lib/log'

const MODULE = 'trial-done'
const UN1T_SOURCE = 'un1t_online'
const BOARD_MODULE = 'acquisition_un1t'
const STAGE_SLUG = 'trial_done'
const ACTIVITY_TYPE = 'agent_trial_done'
const OPENER_SUBJECT = 'Mia messaged after their trial'
const PAGE = 1000
const KEY_CHUNK = 200

const OUTREACH_COLS = 'id, location_id, contact_id, deal_id, trigger_kind, trigger_at, opener_claimed_at, opener_sent_at, opener_wa_message_id, followup_kind, followup_claimed_at, followup_sent_at, closed_at, closed_reason'
const CONTACT_COLS = 'id, first_name, name, email, wa_phone, phone, wa_status, last_marketing_touch_at'
const TEMPLATE_COLS = 'name, language, status, components, header_media_url, business_account_id'

const iso = (ms) => new Date(ms).toISOString()

/**
 * One cron tick of trial-done outreach. Never throws for a person or a studio.
 * @returns {Promise<{ openers: number, followups: number, skipped: number, reasons: Record<string, number> }>}
 */
export async function runTrialDoneOutreach(db, { nowMs = Date.now() } = {}) {
  const results = { openers: 0, followups: 0, skipped: 0, reasons: {} }
  const skip = (reason) => {
    results.skipped++
    results.reasons[reason] = (results.reasons[reason] || 0) + 1
  }

  const { data: locations, error: locErr } = await db.from('locations')
    .select('id, name, organization_id, membership_source, settings')
    .eq('active', true)
    .eq('membership_source', UN1T_SOURCE)
  if (locErr) {
    logError(MODULE, 'studio read failed; nothing sent this tick', { err: locErr })
    skip('locations_read_failed')
    return results
  }

  // Settings first: a studio with the feature (or Mia) off is never read.
  const orgCache = new Map()
  const live = []
  for (const location of locations || []) {
    const resolved = await resolveAgentSettingsForLocation(db, location, { orgCache })
    if (!resolved?.ok) { skip('settings_unreadable'); continue }
    const settings = resolved.settings || {}
    // A partial or older stored block gets the defaults under it.
    const td = { ...DEFAULTS.trial_done, ...(settings.trial_done || {}) }
    if (td.enabled !== true) continue
    if (!settings.enabled && !settings.test_mode) continue
    live.push({ location, settings, td })
  }
  if (live.length === 0) return results

  const zones = await readZones(db, live.map((s) => s.location.id))
  for (const studio of live) {
    try {
      await runStudio(db, { ...studio, zone: zones?.get(studio.location.id) ?? null, nowMs, results, skip })
    } catch (e) {
      logError(MODULE, 'studio tick failed; the next tick retries', { locationId: studio.location.id, err: e })
      skip('studio_error')
    }
  }
  return results
}

// TZ.5 — every live studio's zone, once per tick. A failed read is never a
// silent Dublin: those studios are skipped this tick.
async function readZones(db, ids) {
  try {
    return await getLocationZones(db, ids)
  } catch (e) {
    if (!(e instanceof LocationZoneReadError)) throw e
    logError(MODULE, 'location zones unreadable; their studios skipped this tick', { locationIds: e.locationIds, err: e.cause || e })
    return null
  }
}

async function runStudio(db, { location, settings, td, zone, nowMs, results, skip }) {
  const studioId = location.id
  if (!zone) { skip('zone_read_failed'); return }
  const window = proactiveWindowOpen(nowMs, settings, zone)
  if (!window.open) { skip(window.reason); return }
  if (!(await studioOwnsWhatsAppNumber(db, studioId))) { skip('no_number'); return }

  const sentToday = await sendsToday(db, studioId, zone, nowMs)
  if (sentToday === null) { skip('cap_read_failed'); return }
  const cap = { sent: sentToday, max: Number(td.daily_cap) }
  if (cap.sent >= cap.max) { skip('daily_cap'); return }

  const deals = await trialDoneDeals(db, studioId)
  if (!deals.ok) { skip(deals.reason); return }
  let candidates = deals.byContact
  // Test contacts only, when the operator listed any.
  const only = Array.isArray(td.only_contact_ids) ? td.only_contact_ids.filter(Boolean) : []
  if (only.length > 0) {
    const keep = new Set(only)
    candidates = new Map([...candidates].filter(([contactId]) => keep.has(contactId)))
  }
  if (candidates.size === 0) return

  const inputs = await loadInputs(db, studioId, nowMs)
  if (!inputs.ok) { skip(inputs.reason); return }

  let rows
  try {
    rows = await outreachRows(db, studioId, [...candidates.keys()])
  } catch (e) {
    logError(MODULE, 'outreach rows unreadable; studio skipped this tick', { locationId: studioId, err: e })
    skip('outreach_read_failed')
    return
  }

  const ctx = {
    db, location, settings, td, zone, nowMs, nowIso: iso(nowMs), cap, results, skip,
    reads: inputs.reads, inputs: inputs.data, rows,
    // read at most once per studio per tick, and only when a send is near
    once: new Map(),
  }
  for (const [contactId, deal] of candidates) {
    let outcome
    try {
      outcome = await processCandidate(ctx, contactId, deal)
    } catch (e) {
      logError(MODULE, 'candidate failed; the next tick retries', { locationId: studioId, contactId, err: e })
      skip('error')
    }
    if (outcome === 'stop_studio') break
  }
}

// Memoise one async read per studio per tick.
function once(ctx, key, fn) {
  if (!ctx.once.has(key)) ctx.once.set(key, fn())
  return ctx.once.get(key)
}

// How many trial-done messages went from this studio today (its own day).
// null = unknown: the caller skips the studio, never reads it as 0.
async function sendsToday(db, studioId, zone, nowMs) {
  const dayStartIso = iso(dayStartMsIn(dayStrIn(nowMs, zone), zone))
  const { count, error } = await db.from('activities')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', studioId)
    .eq('type', ACTIVITY_TYPE)
    .gte('created_at', dayStartIso)
  if (error || typeof count !== 'number') {
    logError(MODULE, 'daily cap unreadable; studio skipped this tick', { locationId: studioId, err: error || { message: 'no count returned' } })
    return null
  }
  return count
}

// Open deals in the trial_done column of the studio's enabled un1t board, one
// per contact (the first by id). Shape of pipeline-reclassify.js's deal read.
async function trialDoneDeals(db, studioId) {
  const { data: pipes, error: pipesErr } = await db.from('pipelines')
    .select('id')
    .eq('location_id', studioId)
    .eq('enabled', true)
    .eq('module', BOARD_MODULE)
  if (pipesErr) {
    logError(MODULE, 'board read failed; studio skipped this tick', { locationId: studioId, err: pipesErr })
    return { ok: false, reason: 'board_read_failed' }
  }
  const pipelineIds = (pipes || []).map((p) => p.id)
  if (pipelineIds.length === 0) return { ok: false, reason: 'no_board' }

  const { data: stages, error: stagesErr } = await db.from('pipeline_stages')
    .select('id')
    .eq('location_id', studioId)
    .in('pipeline_id', pipelineIds)
    .eq('slug', STAGE_SLUG)
  if (stagesErr) {
    logError(MODULE, 'stage read failed; studio skipped this tick', { locationId: studioId, err: stagesErr })
    return { ok: false, reason: 'board_read_failed' }
  }
  const stageIds = (stages || []).map((s) => s.id)
  if (stageIds.length === 0) return { ok: false, reason: 'no_trial_done_stage' }

  let deals
  try {
    deals = await selectAll((from, to) => db.from('deals')
      .select('id, contact_id')
      .eq('location_id', studioId)
      .eq('status', 'open')
      .in('pipeline_id', pipelineIds)
      .in('stage_id', stageIds)
      .order('id', { ascending: true })
      .range(from, to), { pageSize: PAGE })
  } catch (e) {
    logError(MODULE, 'deal read failed; studio skipped this tick', { locationId: studioId, err: e })
    return { ok: false, reason: 'deals_read_failed' }
  }
  const byContact = new Map()
  for (const d of deals) {
    if (d.contact_id && !byContact.has(d.contact_id)) byContact.set(d.contact_id, d)
  }
  return { ok: true, byContact }
}

// The studio's un1t.online reads, and ONE pipelineInputs call for the tick.
async function loadInputs(db, studioId, nowMs) {
  let seam
  try {
    seam = await membershipReadsFor(db, studioId)
  } catch (e) {
    logError(MODULE, 'membership reads unresolved; studio skipped this tick', { locationId: studioId, err: e })
    return { ok: false, reason: 'reads_unavailable' }
  }
  if (seam?.state !== 'configured' || seam?.source !== UN1T_SOURCE
      || !supportsRead(seam, 'pipelineInputs') || !supportsRead(seam, 'trialEligibility')) {
    logWarn(MODULE, 'un1t.online reads unavailable; studio skipped this tick', { locationId: studioId, state: seam?.state ?? null, source: seam?.source ?? null })
    return { ok: false, reason: 'reads_unavailable' }
  }
  let res
  try {
    res = await seam.reads.pipelineInputs(db, studioId, { now: nowMs })
  } catch (e) {
    res = { success: false, error: e?.message || String(e) }
  }
  const data = res?.success ? res.data : null
  if (!data || !(data.snapshots instanceof Map) || !(data.evidence instanceof Map)) {
    logError(MODULE, 'pipeline inputs unreadable; studio skipped this tick', { locationId: studioId, err: { message: String(res?.error || 'malformed answer').slice(0, 200) } })
    return { ok: false, reason: 'inputs_unreadable' }
  }
  return { ok: true, reads: seam.reads, data }
}

// Existing outreach rows for these contacts at this studio. Throws on a failed read.
async function outreachRows(db, studioId, contactIds) {
  const rows = await selectAllByKeys(contactIds, (keys, from, to) => db.from('trial_done_outreach')
    .select(OUTREACH_COLS)
    .eq('location_id', studioId)
    .in('contact_id', keys)
    .order('id', { ascending: true })
    .range(from, to), { chunkSize: KEY_CHUNK, pageSize: PAGE })
  return new Map(rows.map((r) => [r.contact_id, r]))
}

/**
 * One person on the trial_done column. The opener stage today; TRIALDONE.5
 * adds the follow-up stage for rows whose opener went (opener_sent_at set,
 * not closed) before falling through to the opener stage.
 * Returns 'stop_studio' when the studio must stop for this tick.
 */
async function processCandidate(ctx, contactId, deal) {
  const snapshot = ctx.inputs.snapshots.get(contactId)
  if (!snapshot) { ctx.skip('no_un1t_record'); return null }
  const trigger = trialDoneEvidenceAt(ctx.inputs.evidence.get(contactId))

  let row = ctx.rows.get(contactId) || null
  if (!row) {
    if (!trigger) { ctx.skip('no_trigger'); return null }
    row = await ensureOutreachRow(ctx, contactId, deal, trigger)
    if (!row) { ctx.skip('outreach_write_failed'); return null }
    ctx.rows.set(contactId, row)
  }
  return openerStage(ctx, { contactId, snapshot, trigger, row })
}

// Insert the person's row once ever (on conflict do nothing); a row another
// tick inserted first is read back.
async function ensureOutreachRow(ctx, contactId, deal, trigger) {
  const { db, location } = ctx
  const { data, error } = await db.from('trial_done_outreach')
    .upsert({
      location_id: location.id,
      contact_id: contactId,
      deal_id: deal?.id ?? null,
      trigger_kind: trigger.kind,
      trigger_at: trigger.at,
    }, { onConflict: 'location_id,contact_id', ignoreDuplicates: true })
    .select(OUTREACH_COLS)
  if (error) {
    logError(MODULE, 'outreach row insert failed; skipped this tick', { locationId: location.id, contactId, err: error })
    return null
  }
  if (data?.[0]) return data[0]
  // unique (location_id, contact_id): at most one row
  const { data: existing, error: readErr } = await db.from('trial_done_outreach')
    .select(OUTREACH_COLS)
    .eq('location_id', location.id)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (readErr || !existing) {
    logError(MODULE, 'outreach row unreadable after insert; skipped this tick', { locationId: location.id, contactId, err: readErr || { message: 'no row' } })
    return null
  }
  return existing
}

async function closeRow(ctx, row, reason) {
  const { error } = await ctx.db.from('trial_done_outreach')
    .update({ closed_at: ctx.nowIso, closed_reason: reason, updated_at: ctx.nowIso })
    .eq('id', row.id)
    .is('closed_at', null)
    .select('id')
  // A lost close re-decides next tick (the same verdict closes it then).
  if (error) logError(MODULE, 'outreach close failed; the next tick re-decides', { rowId: row.id, reason, err: error })
}

// The fresh reads behind eligibilityVerdict. A failed read is a skip reason,
// never "eligible" and never a close.
async function eligibilityInputs(ctx, contact) {
  const { db, location } = ctx
  const studioId = location.id

  // WAORGNUMBER.3 — THIS studio's WhatsApp marketing consent; row absent = no.
  const { data: prefs, error: prefsErr } = await db.from('contact_location_preferences')
    .select('whatsapp_marketing')
    .eq('contact_id', contact.id)
    .eq('location_id', studioId)
    .maybeSingle()
  if (prefsErr) {
    logError(MODULE, 'consent read failed; skipped this tick', { locationId: studioId, contactId: contact.id, err: prefsErr })
    return { ok: false, reason: 'consent_read_failed' }
  }

  // Staff: the contact's email equals a live (non-tombstoned) profile's,
  // case-insensitively. escapeLikePattern makes .ilike an equality.
  let isStaff = false
  const email = String(contact.email || '').trim()
  if (email) {
    const { data: staff, error: staffErr } = await db.from('profiles')
      .select('id')
      .ilike('email', escapeLikePattern(email))
      .is('deleted_at', null)
      .limit(1)
    if (staffErr) {
      logError(MODULE, 'staff read failed; skipped this tick', { locationId: studioId, contactId: contact.id, err: staffErr })
      return { ok: false, reason: 'staff_unreadable' }
    }
    isStaff = (staff || []).length > 0
  }

  // Active members at another studio of the organisation: once per studio per tick.
  let elsewhere
  try {
    elsewhere = await once(ctx, 'active_elsewhere', () => loadActiveElsewhere(db, studioId))
  } catch (e) {
    elsewhere = { ok: false, reason: 'threw', err: e?.message || String(e) }
  }
  if (!elsewhere?.ok) {
    if (!ctx.once.has('active_elsewhere_logged')) {
      ctx.once.set('active_elsewhere_logged', true)
      logError(MODULE, 'active-elsewhere read failed; candidates skipped this tick', { locationId: studioId, reason: elsewhere?.reason ?? null })
    }
    return { ok: false, reason: 'active_elsewhere_unreadable' }
  }

  // What they have bought here: a fresh read for this person (the ruling: not
  // the tick's pipelineInputs evidence).
  let elig
  try {
    elig = await ctx.reads.trialEligibility(db, studioId, { contactId: contact.id })
  } catch (e) {
    elig = { success: false, error: e?.message || String(e) }
  }
  if (!elig?.success || !Array.isArray(elig.data?.reasons)) {
    logError(MODULE, 'trial eligibility unreadable; skipped this tick', { locationId: studioId, contactId: contact.id, err: { message: String(elig?.error || 'malformed answer').slice(0, 200) } })
    return { ok: false, reason: 'eligibility_unreadable' }
  }

  return {
    ok: true,
    values: {
      eligibilityReasons: elig.data.reasons,
      activeElsewhere: elsewhere.contactIds?.has?.(contact.id) === true,
      isStaff,
      waStatus: contact.wa_status ?? null,
      hasConsent: prefs?.whatsapp_marketing === true,
    },
  }
}

// The opener template at this studio, newest first: once per studio per tick.
function openerTemplate(ctx) {
  return once(ctx, 'opener_template', async () => {
    const { data, error } = await ctx.db.from('whatsapp_templates')
      .select(TEMPLATE_COLS)
      .eq('location_id', ctx.location.id)
      .eq('name', ctx.td.opener_template)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) {
      logError(MODULE, 'template read failed; skipped this tick', { locationId: ctx.location.id, err: error })
      return { ok: false, reason: 'template_read_failed' }
    }
    const template = data?.[0]
    if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') {
      return { ok: false, reason: 'template_not_approved' }
    }
    return { ok: true, template }
  })
}

// Conditional claim: only an unsent, open row whose claim is empty or past the lease.
async function claimOpener(ctx, row) {
  const cutoffIso = iso(ctx.nowMs - TRIAL_DONE_CLAIM_LEASE_MS)
  const { data, error } = await ctx.db.from('trial_done_outreach')
    .update({ opener_claimed_at: ctx.nowIso, updated_at: ctx.nowIso })
    .eq('id', row.id)
    .is('opener_sent_at', null)
    .is('closed_at', null)
    .or(`opener_claimed_at.is.null,opener_claimed_at.lt.${cutoffIso}`)
    .select('id')
  if (error) {
    logError(MODULE, 'opener claim failed; nothing sent this tick', { rowId: row.id, err: error })
    return { ok: false, reason: 'claim_failed' }
  }
  if (!data?.length) return { ok: false, reason: 'claimed' }
  return { ok: true, at: ctx.nowIso }
}

// Undo OUR claim after a send that did not go, so the next tick retries.
// Pinned to the claim's own value; if this write fails the lease re-opens it.
async function releaseOpener(ctx, row, claimAt) {
  const { error } = await ctx.db.from('trial_done_outreach')
    .update({ opener_claimed_at: null, updated_at: ctx.nowIso })
    .eq('id', row.id)
    .eq('opener_claimed_at', claimAt)
  if (error) logError(MODULE, 'opener claim release failed; the lease re-opens it', { rowId: row.id, err: error })
}

async function openerStage(ctx, { contactId, snapshot, trigger, row }) {
  const { db, location, settings, td, nowMs, nowIso, skip } = ctx
  const studioId = location.id

  const decision = openerDecision({ trigger, outreach: row, nowMs, settings: td })
  if (decision.action !== 'opener') {
    if (decision.reason === 'stale') await closeRow(ctx, row, 'stale')
    skip(decision.reason)
    return null
  }
  if (ctx.cap.sent >= ctx.cap.max) { skip('daily_cap'); return 'stop_studio' }

  const { data: contact, error: contactErr } = await db.from('contacts')
    .select(CONTACT_COLS)
    .eq('id', contactId)
    .maybeSingle()
  if (contactErr) {
    logError(MODULE, 'contact read failed; skipped this tick', { locationId: studioId, contactId, err: contactErr })
    skip('contact_read_failed')
    return null
  }
  if (!contact) { skip('contact_missing'); return null }

  const facts = await eligibilityInputs(ctx, contact)
  if (!facts.ok) { skip(facts.reason); return null }
  const verdict = eligibilityVerdict({ stage: classifyUn1t(snapshot, nowMs), ...facts.values })
  if (!verdict.ok) {
    await closeRow(ctx, row, verdict.reason)
    skip(verdict.reason)
    return null
  }

  const to = contact.wa_phone
  if (!to) { skip('no_phone'); return null }
  // Mia in test mode (not enabled): her test phones only, as every proactive runner.
  if (!settings.enabled && settings.test_mode && !phoneMatchesAllowlist(to, settings.test_phones)) {
    skip('test_allowlist')
    return null
  }

  const capSetting = await once(ctx, 'frequency_cap', () => getLocationFrequencyCap(db, studioId))
  if (isFrequencyCapped(contact, capSetting, new Date(nowMs))) { skip('frequency_capped'); return null }

  const tpl = await openerTemplate(ctx)
  if (!tpl.ok) { skip(tpl.reason); return null }
  const template = tpl.template

  const claim = await claimOpener(ctx, row)
  if (!claim.ok) { skip(claim.reason); return null }

  const { extractTemplateBody } = await import('@/lib/radar-outreach')
  const { sendTemplateMessage, headerComponentFor, getOrCreateConversation } = await import('@/lib/whatsapp')
  const firstName = (contact.first_name || String(contact.name || '').split(/\s+/)[0] || 'there').trim() || 'there'
  const values = [firstName]
  const { varCount } = extractTemplateBody(template.components)
  const components = buildFollowupComponents(varCount, values)
  const headerComponent = headerComponentFor(template.components, template.header_media_url)
  if (headerComponent) components.unshift(headerComponent)

  let res
  try {
    res = await sendTemplateMessage(to, template.name, template.language || 'en', components,
      { locationId: studioId, ...(template.business_account_id && { businessAccountId: template.business_account_id }) })
  } catch (e) {
    await releaseOpener(ctx, row, claim.at)
    if (isWhatsAppNumberMissing(e)) { skip('no_number'); return null }
    logError(MODULE, 'opener send failed; claim released, the next tick retries', { locationId: studioId, contactId, err: e })
    skip('send_failed')
    return null
  }
  if (!res?.messageId) {
    await releaseOpener(ctx, row, claim.at)
    logWarn(MODULE, 'opener send returned no message id; claim released', { locationId: studioId, contactId })
    skip('send_failed')
    return null
  }

  // Sent. The bookkeeping below never undoes it; each loss is logged.
  ctx.cap.sent++
  ctx.results.openers++
  const { error: sentErr } = await db.from('trial_done_outreach')
    .update({ opener_sent_at: nowIso, opener_wa_message_id: res.messageId, updated_at: nowIso })
    .eq('id', row.id)
  if (sentErr) {
    logError(MODULE, 'opener sent but not stamped; the lease could send it again', { rowId: row.id, contactId, waMessageId: res.messageId, err: sentErr })
  }

  let conversationId = null
  try {
    conversationId = await getOrCreateConversation(db, { id: contact.id, wa_phone: contact.wa_phone, phone: contact.phone, name: contact.name }, studioId)
  } catch (e) {
    logError(MODULE, 'opener thread unavailable; message not recorded in the inbox', { locationId: studioId, contactId, err: e })
  }
  if (conversationId) {
    await recordProactiveMessage(db, { id: conversationId, contact_id: contact.id, location_id: studioId }, {
      body: renderFollowupBody(template, values) || `[Template: ${template.name}]`,
      waMessageId: res.messageId, messageType: 'template', templateName: template.name,
    })
  } else {
    logWarn(MODULE, 'opener thread not found or created; message not recorded in the inbox', { locationId: studioId, contactId })
  }

  const { error: actErr } = await db.from('activities').insert({
    contact_id: contact.id,
    location_id: studioId,
    type: ACTIVITY_TYPE,
    kind: 'event',
    subject: OPENER_SUBJECT,
    note: template.name,
  })
  if (actErr) logError(MODULE, 'opener activity not recorded; the daily cap undercounts it', { locationId: studioId, contactId, err: actErr })

  await stampMarketingTouch(db, [contact.id], nowIso)
  return null
}
