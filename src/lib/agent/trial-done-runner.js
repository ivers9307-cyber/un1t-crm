// TRIALDONE.4/.5 — the trial-done outreach runner (spec:
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
// TRIALDONE.5 — once the opener went, the same row runs the follow-up stage
// instead (at most one follow-up, ever):
//   a. followupDecision after opener_sent_at only (their replies on any
//      thread of the organisation, the studio's own last word on its thread):
//      no reply = the follow-up template 22-30 h after the opener; replied and
//      Mia answered last = one Mia-written nudge 3-20 h after their last
//      message (inside WhatsApp's 24 h window); the customer waiting on Mia =
//      nothing; past either window the row is closed 'window_passed';
//   b. eligibilityVerdict again, fresh (bought closes 'purchased', opted out
//      or consent withdrawn closes 'opted_out', and so on);
//   c. the opener's gates: test-mode allowlist, the frequency cap (template
//      only: the nudge is a reply inside the window), the template approved;
//      a nudge also waits while the thread is handed off or paused;
//   d. claim on the followup_* columns (followup_kind set at claim), send,
//      record exactly as the opener.
//
// TRIALDONE.7 — the final review's fixes:
//   * the sale path must be on (Mia's un1t chat actions: the studio's
//     un1t_chat_actions_enabled AND its un1t writes_enabled, the rule
//     turn-studios.js applies to a turn), else the studio is skipped
//     'sale_path_off': no opener goes out that Mia could not follow through;
//   * the sweep: an OPEN row whose opener went, for a person no longer on the
//     trial_done column, is judged fresh like a send and closed with its
//     reason (purchased, opted_out, staff, ...), or 'left_trial_done' when
//     still eligible, so Mia's brief (trial-done-context.js) stops for them.
//     A failed read defers, never closes;
//   * a reply counts on ANY thread of the organisation for this contact or
//     number (a reply on the shared org number can file at another studio);
//     Mia's last outbound and the nudge stay on the studio's own thread;
//   * an opener whose evidence has no trigger now is timed from the stored
//     trigger_at, so the row still goes stale.
//
// TRIALDONE.8 — the sweep is its own pass, run first for every studio whose
// trial_done.enabled is true, ahead of and independent of the send-only gates
// (the sale path, Mia on or in test mode, daytime and quiet hours, a number
// switched on, the daily cap): it sends nothing, so a buyer's row closes (and
// Mia's brief stops) at 22:00, at the cap, or with the sale path off. It keeps
// the un1t.online source, only_contact_ids (malformed = the whole studio
// skipped) and defer-on-failure: a failed read of the opened rows, the board
// or the pipeline inputs counts 'sweep_read_failed' and closes nothing. The
// deals and the pipeline inputs are read at most once per studio per tick and
// shared with the send pass, whose gates are unchanged.
//
// Every skip is a counted reason (results.reasons), carried on the cron
// heartbeat and on the arm's own row ('trial-done-outreach', mig 757). Never
// throws for one person or one studio.

import { DEFAULTS } from './settings-contract'
import { resolveAgentSettingsForLocation } from './settings-resolve'
import {
  proactiveWindowOpen, buildFollowupComponents, renderFollowupBody,
  recordProactiveMessage, studioOwnsWhatsAppNumber,
  composeAgentText, loadAgentKnowledge, promptCapabilityFor,
} from './followups'
import { phoneMatchesAllowlist, isSkipResponse, parseAgentResponse } from './core'
import {
  openerDecision, followupDecision, eligibilityVerdict,
  TRIAL_DONE_CLAIM_LEASE_MS, TRIAL_DONE_NUDGE_INSTRUCTION,
} from './trial-done'
import { getLocationBranding } from '@/lib/location-branding'
import { UUID_SHAPE } from '@/lib/uuid-shape'
import { classify as classifyUn1t } from '@shared/pipelines/acquisition-un1t'
import { trialDoneEvidenceAt } from '@/lib/membership/reads/un1t-pipeline-dates'
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { loadActiveElsewhere } from '@/lib/pipeline-other-studio-members'
import { isFrequencyCapped, getLocationFrequencyCap, stampMarketingTouch } from '@/lib/frequency-cap'
import { getLocationZones, LocationZoneReadError, dayStrIn, dayStartMsIn } from '@/lib/location-time'
import { escapeLikePattern } from '@/lib/like-escape'
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { isWhatsAppNumberMissing } from '@/lib/whatsapp-number-missing'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { logError, logWarn } from '@/lib/log'

const MODULE = 'trial-done'
const UN1T_SOURCE = 'un1t_online'
const BOARD_MODULE = 'acquisition_un1t'
const STAGE_SLUG = 'trial_done'
const ACTIVITY_TYPE = 'agent_trial_done'
const OPENER_SUBJECT = 'Mia messaged after their trial'
const FOLLOWUP_SUBJECT = 'Mia followed up after their trial'
const HISTORY_ROWS = 15
const PAGE = 1000
const KEY_CHUNK = 200

const OUTREACH_COLS = 'id, location_id, contact_id, deal_id, trigger_kind, trigger_at, opener_claimed_at, opener_sent_at, opener_wa_message_id, followup_kind, followup_claimed_at, followup_sent_at, closed_at, closed_reason'
const CONTACT_COLS = 'id, first_name, name, email, wa_phone, phone, wa_status, last_marketing_touch_at'
const TEMPLATE_COLS = 'name, language, status, components, header_media_url, business_account_id'
const CONVERSATION_COLS = 'id, agent_active, agent_handed_off_at, agent_paused_at'
const HISTORY_COLS = 'direction, source, sent_by, body, created_at, message_type'

// The two send stages share one claim/send/record path on their own columns.
const STAGES = {
  opener: { label: 'opener', claimed: 'opener_claimed_at', sent: 'opener_sent_at', waId: 'opener_wa_message_id', kind: null },
  followup: { label: 'follow-up', claimed: 'followup_claimed_at', sent: 'followup_sent_at', waId: 'followup_wa_message_id', kind: 'followup_kind' },
}

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

  // Settings first: a studio with the feature off is never read. Mia off or
  // the sale path off stops only the send pass (TRIALDONE.8: the sweep sends
  // nothing, so it still runs there).
  const orgCache = new Map()
  const live = []
  for (const location of locations || []) {
    const resolved = await resolveAgentSettingsForLocation(db, location, { orgCache })
    if (!resolved?.ok) { skip('settings_unreadable'); continue }
    const settings = resolved.settings || {}
    // A partial or older stored block gets the defaults under it.
    const td = { ...DEFAULTS.trial_done, ...(settings.trial_done || {}) }
    if (td.enabled !== true) continue
    let sends = true
    if (!settings.enabled && !settings.test_mode) sends = false
    else if (!salePathOn(settings, location)) { skip('sale_path_off'); sends = false }
    live.push({ location, settings, td, sends })
  }
  if (live.length === 0) return results

  // Zones only for studios that may send: the sweep needs no clock.
  const sending = live.filter((s) => s.sends)
  const zones = sending.length ? await readZones(db, sending.map((s) => s.location.id)) : null
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

// TRIALDONE.7 — may Mia sell at this studio? The same rule turn-studios.js
// (un1tChatActionsOn) applies before a turn gets the purchase tools: the
// studio's Mia switch un1t_chat_actions_enabled (MIAHATCH.6, studio-only,
// default off) AND its locations.settings.un1t_online.writes_enabled. Only a
// literal true counts.
function salePathOn(settings, location) {
  if (settings?.un1t_chat_actions_enabled !== true) return false
  return un1tWriteSettingsFrom(location?.settings).writesEnabled === true
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

// only_contact_ids: absent or [] = everyone; a list = those ids only (the
// malformed entries dropped); anything else, or a list with no valid id, is
// invalid and the studio is skipped. Never "everyone" by accident.
function testContactList(value) {
  if (value === undefined) return { ok: true, ids: null }
  if (!Array.isArray(value)) return { ok: false }
  if (value.length === 0) return { ok: true, ids: null }
  const ids = value.filter((v) => typeof v === 'string' && UUID_SHAPE.test(v))
  return ids.length > 0 ? { ok: true, ids } : { ok: false }
}

async function runStudio(db, { location, settings, td, sends, zone, nowMs, results, skip }) {
  const studioId = location.id
  const testList = testContactList(td.only_contact_ids)
  if (!testList.ok) {
    logError(MODULE, 'only_contact_ids is malformed; studio skipped this tick (never everyone)', { locationId: studioId, valueType: Array.isArray(td.only_contact_ids) ? 'array' : typeof td.only_contact_ids })
    skip('test_list_invalid')
    return
  }

  const ctx = {
    db, location, settings, td, zone, nowMs, nowIso: iso(nowMs), cap: null, results, skip,
    reads: null, inputs: null, rows: new Map(),
    // read at most once per studio per tick (the deals and the pipeline
    // inputs are shared by the two passes), and only when needed
    once: new Map(),
  }

  // TRIALDONE.8 — pass 1, the sweep: before every send-only gate. A throw
  // here never costs the send pass.
  try {
    await sweepPass(ctx, testList.ids)
  } catch (e) {
    logError(MODULE, 'sweep failed; the next tick retries (nothing closed by this pass)', { locationId: studioId, err: e })
    skip('studio_error')
  }

  // Pass 2, the sends: every gate exactly as before.
  if (sends) await sendPass(ctx, testList.ids)
}

// The studio's trial_done deals and its pipeline inputs: once per studio per tick.
const studioDeals = (ctx) => once(ctx, 'deals', () => trialDoneDeals(ctx.db, ctx.location.id))
async function studioInputs(ctx) {
  const inputs = await once(ctx, 'inputs', () => loadInputs(ctx.db, ctx.location.id, ctx.nowMs))
  if (inputs.ok) { ctx.reads = inputs.reads; ctx.inputs = inputs.data }
  return inputs
}

// Read failures (never "not configured") defer the sweep as a counted fault.
const SWEEP_READ_FAILURES = new Set(['board_read_failed', 'deals_read_failed', 'inputs_unreadable'])

// TRIALDONE.7/.8 — opened rows whose person left the trial_done column, each
// judged fresh and closed with its reason (sweepRow). A failed read defers the
// whole sweep ('sweep_read_failed'): nobody is closed on a guess. A studio
// with no board, no trial_done stage or no un1t.online reads has no column to
// leave: the sweep waits, and the send pass reports that state as before.
async function sweepPass(ctx, testIds) {
  const { db, location, skip } = ctx
  const studioId = location.id
  let opened
  try {
    opened = await openedRows(db, studioId, testIds)
  } catch (e) {
    logError(MODULE, 'opened rows unreadable; the sweep waits for the next tick (nothing closed)', { locationId: studioId, err: e })
    skip('sweep_read_failed')
    return
  }
  if (opened.length === 0) return

  const deals = await studioDeals(ctx)
  if (!deals.ok) {
    if (SWEEP_READ_FAILURES.has(deals.reason)) skip('sweep_read_failed')
    return
  }
  const strays = opened.filter((r) => !deals.byContact.has(r.contact_id))
  if (strays.length === 0) return

  const inputs = await studioInputs(ctx)
  if (!inputs.ok) {
    if (SWEEP_READ_FAILURES.has(inputs.reason)) skip('sweep_read_failed')
    return
  }
  for (const row of strays) {
    try {
      await sweepRow(ctx, row)
    } catch (e) {
      logError(MODULE, 'sweep of an opened row failed; the next tick retries', { locationId: studioId, contactId: row.contact_id, err: e })
      skip('error')
    }
  }
}

// The opener and follow-up sends, behind the studio's send gates.
async function sendPass(ctx, testIds) {
  const { db, location, settings, td, zone, nowMs, skip } = ctx
  const studioId = location.id
  if (!zone) { skip('zone_read_failed'); return }
  const window = proactiveWindowOpen(nowMs, settings, zone)
  if (!window.open) { skip(window.reason); return }
  if (!(await studioOwnsWhatsAppNumber(db, studioId))) { skip('no_number'); return }

  const sentToday = await sendsToday(db, studioId, zone, nowMs)
  if (sentToday === null) { skip('cap_read_failed'); return }
  ctx.cap = { sent: sentToday, max: Number(td.daily_cap) }
  if (ctx.cap.sent >= ctx.cap.max) { skip('daily_cap'); return }

  const deals = await studioDeals(ctx)
  if (!deals.ok) { skip(deals.reason); return }
  let candidates = deals.byContact
  // Test contacts only, when the operator listed any.
  if (testIds) {
    const keep = new Set(testIds)
    candidates = new Map([...candidates].filter(([contactId]) => keep.has(contactId)))
  }
  if (candidates.size === 0) return

  const inputs = await studioInputs(ctx)
  if (!inputs.ok) { skip(inputs.reason); return }

  try {
    ctx.rows = await outreachRows(db, studioId, [...candidates.keys()])
  } catch (e) {
    logError(MODULE, 'outreach rows unreadable; studio skipped this tick', { locationId: studioId, err: e })
    skip('outreach_read_failed')
    return
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

// TRIALDONE.7 — this studio's OPEN rows whose opener went (with
// only_contact_ids set, its contacts only: nobody outside the test list is
// touched). Paginated past the 1,000-row cap. Throws on a failed read.
async function openedRows(db, studioId, testIds) {
  const rows = await selectAll((from, to) => db.from('trial_done_outreach')
    .select(OUTREACH_COLS)
    .eq('location_id', studioId)
    .is('closed_at', null)
    .not('opener_sent_at', 'is', null)
    .order('id', { ascending: true })
    .range(from, to), { pageSize: PAGE })
  const keep = testIds ? new Set(testIds) : null
  return keep ? rows.filter((r) => keep.has(r.contact_id)) : rows
}

// TRIALDONE.7 — one opened row whose person left the column: the same fresh
// eligibility as before a send closes it with its reason (no consent after
// the opener is 'opted_out'); still eligible closes 'left_trial_done'. An
// unreadable read is a skip (judgeEligibility), never a close. No un1t
// record for them now is no classification (never trial_done).
async function sweepRow(ctx, row) {
  const contact = await readContact(ctx, row.contact_id)
  if (!contact) return
  const snapshot = ctx.inputs.snapshots.get(row.contact_id) || null
  if (!(await judgeEligibility(ctx, { contact, snapshot, row, closeAs: followupCloseReason }))) return
  await closeRow(ctx, row, 'left_trial_done')
  ctx.skip('left_trial_done')
}

/**
 * One person on the trial_done column: the opener stage until the opener went,
 * then the follow-up stage (TRIALDONE.5).
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
  if (row.opener_sent_at) return followupStage(ctx, { contactId, snapshot, row })
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

// The contact, read fresh. null = skipped (the reason counted).
async function readContact(ctx, contactId) {
  const { data: contact, error } = await ctx.db.from('contacts')
    .select(CONTACT_COLS)
    .eq('id', contactId)
    .maybeSingle()
  if (error) {
    logError(MODULE, 'contact read failed; skipped this tick', { locationId: ctx.location.id, contactId, err: error })
    ctx.skip('contact_read_failed')
    return null
  }
  if (!contact) { ctx.skip('contact_missing'); return null }
  return contact
}

// eligibilityVerdict on fresh reads. Not eligible closes the row with
// closeAs(reason); an unreadable read or a missing input is a skip this tick
// (the row stays open), never "eligible" and never a close. true = eligible.
async function judgeEligibility(ctx, { contact, snapshot, row, closeAs = (reason) => reason }) {
  const facts = await eligibilityInputs(ctx, contact)
  if (!facts.ok) { ctx.skip(facts.reason); return false }
  const stage = snapshot ? classifyUn1t(snapshot, ctx.nowMs) : null
  const verdict = eligibilityVerdict({ stage, ...facts.values })
  if (verdict.ok) return true
  if (verdict.reason === 'inputs_missing') {
    logError(MODULE, 'eligibility inputs missing; skipped this tick', { locationId: ctx.location.id, contactId: contact.id })
    ctx.skip('inputs_missing')
    return false
  }
  const reason = closeAs(verdict.reason)
  await closeRow(ctx, row, reason)
  ctx.skip(reason)
  return false
}

// After the opener a withdrawn consent row is an opt-out: the row closes
// 'opted_out' (the reason Mia's trial-done context reads), as wa_status does.
const followupCloseReason = (reason) => (reason === 'no_consent' ? 'opted_out' : reason)

// The gates every send passes after eligibility: a number to send to, Mia's
// test-mode allowlist, and (a marketing template only) the studio's frequency
// cap, which defers and never closes. null = clear, else the skip reason.
async function sendGate(ctx, contact, { frequencyCap }) {
  const { db, location, settings, nowMs } = ctx
  const to = contact.wa_phone
  if (!to) return 'no_phone'
  // Mia in test mode (not enabled): her test phones only, as every proactive runner.
  if (!settings.enabled && settings.test_mode && !phoneMatchesAllowlist(to, settings.test_phones)) return 'test_allowlist'
  if (frequencyCap) {
    const capSetting = await once(ctx, 'frequency_cap', () => getLocationFrequencyCap(db, location.id))
    if (isFrequencyCapped(contact, capSetting, new Date(nowMs))) return 'frequency_capped'
  }
  return null
}

// A template at this studio by name, newest first: once per studio per tick.
function approvedTemplate(ctx, name) {
  return once(ctx, `template:${name}`, async () => {
    const { data, error } = await ctx.db.from('whatsapp_templates')
      .select(TEMPLATE_COLS)
      .eq('location_id', ctx.location.id)
      .eq('name', name)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) {
      logError(MODULE, 'template read failed; skipped this tick', { locationId: ctx.location.id, template: name, err: error })
      return { ok: false, reason: 'template_read_failed' }
    }
    const template = data?.[0]
    if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') {
      return { ok: false, reason: 'template_not_approved' }
    }
    return { ok: true, template }
  })
}

// Conditional claim of one stage: only an open row whose stage is unsent and
// whose claim is empty or past the lease. The follow-up claim also sets
// followup_kind.
async function claimStage(ctx, row, stage, kind = null) {
  const c = STAGES[stage]
  const cutoffIso = iso(ctx.nowMs - TRIAL_DONE_CLAIM_LEASE_MS)
  const { data, error } = await ctx.db.from('trial_done_outreach')
    .update({ [c.claimed]: ctx.nowIso, ...(c.kind ? { [c.kind]: kind } : {}), updated_at: ctx.nowIso })
    .eq('id', row.id)
    .is(c.sent, null)
    .is('closed_at', null)
    .or(`${c.claimed}.is.null,${c.claimed}.lt.${cutoffIso}`)
    .select('id')
  if (error) {
    logError(MODULE, `${c.label} claim failed; nothing sent this tick`, { rowId: row.id, err: error })
    return { ok: false, reason: 'claim_failed' }
  }
  if (!data?.length) return { ok: false, reason: 'claimed' }
  return { ok: true, at: ctx.nowIso }
}

// Undo OUR claim after a send that did not go, so the next tick retries.
// Pinned to the claim's own value; if this write fails the lease re-opens it.
async function releaseStage(ctx, row, stage, claimAt) {
  const c = STAGES[stage]
  const { error } = await ctx.db.from('trial_done_outreach')
    .update({ [c.claimed]: null, ...(c.kind ? { [c.kind]: null } : {}), updated_at: ctx.nowIso })
    .eq('id', row.id)
    .eq(c.claimed, claimAt)
  if (error) logError(MODULE, `${c.label} claim release failed; the lease re-opens it`, { rowId: row.id, err: error })
}

// A send that did not go: release the claim, count the reason. Always null.
async function sendFailed(ctx, { row, stage, claimAt, contactId, err }) {
  await releaseStage(ctx, row, stage, claimAt)
  const label = STAGES[stage].label
  if (err && isWhatsAppNumberMissing(err)) { ctx.skip('no_number'); return null }
  if (err) logError(MODULE, `${label} send failed; claim released, the next tick retries`, { locationId: ctx.location.id, contactId, err })
  else logWarn(MODULE, `${label} send returned no message id; claim released`, { locationId: ctx.location.id, contactId })
  ctx.skip('send_failed')
  return null
}

const firstNameOf = (contact) => (contact.first_name || String(contact.name || '').split(/\s+/)[0] || 'there').trim() || 'there'

// Send one claimed template with {{1}} = the first name. Returns
// { messageId, body } once Meta accepted it; null after a failed send (the
// claim released, the reason counted).
async function sendClaimedTemplate(ctx, { row, stage, claimAt, contact, template }) {
  const { extractTemplateBody } = await import('@/lib/radar-outreach')
  const { sendTemplateMessage, headerComponentFor } = await import('@/lib/whatsapp')
  const values = [firstNameOf(contact)]
  const { varCount } = extractTemplateBody(template.components)
  const components = buildFollowupComponents(varCount, values)
  const headerComponent = headerComponentFor(template.components, template.header_media_url)
  if (headerComponent) components.unshift(headerComponent)

  let res
  try {
    res = await sendTemplateMessage(contact.wa_phone, template.name, template.language || 'en', components,
      { locationId: ctx.location.id, ...(template.business_account_id && { businessAccountId: template.business_account_id }) })
  } catch (err) {
    return sendFailed(ctx, { row, stage, claimAt, contactId: contact.id, err })
  }
  if (!res?.messageId) return sendFailed(ctx, { row, stage, claimAt, contactId: contact.id, err: null })
  return { messageId: res.messageId, body: renderFollowupBody(template, values) || `[Template: ${template.name}]` }
}

// Sent. The bookkeeping below never undoes it; each loss is logged, and none
// stops the next one (a duplicate risk is logged loudly, never a lost message).
async function afterSend(ctx, { row, stage, contact, messageId, conversationId, body, messageType, templateName, subject, note }) {
  const { db, location, nowIso } = ctx
  const studioId = location.id
  const c = STAGES[stage]
  ctx.cap.sent++
  if (stage === 'opener') ctx.results.openers++
  else ctx.results.followups++

  // Judged by its rows: a zero-row UPDATE is not an error in PostgREST.
  const { data: stamped, error: sentErr } = await db.from('trial_done_outreach')
    .update({ [c.sent]: nowIso, [c.waId]: messageId, updated_at: nowIso })
    .eq('id', row.id)
    .select('id')
  if (sentErr || !stamped?.length) {
    logError(MODULE, `${c.label} sent but not stamped; the lease could send it again`, {
      rowId: row.id, contactId: contact.id, waMessageId: messageId, rows: stamped?.length ?? null, ...(sentErr ? { err: sentErr } : {}),
    })
  }

  let threadId = conversationId || null
  if (!threadId) {
    try {
      const { getOrCreateConversation } = await import('@/lib/whatsapp')
      threadId = await getOrCreateConversation(db, { id: contact.id, wa_phone: contact.wa_phone, phone: contact.phone, name: contact.name }, studioId)
    } catch (e) {
      logError(MODULE, `${c.label} thread unavailable; message not recorded in the inbox`, { locationId: studioId, contactId: contact.id, waMessageId: messageId, err: e })
    }
  }
  if (threadId) {
    try {
      await recordProactiveMessage(db, { id: threadId, contact_id: contact.id, location_id: studioId }, {
        body, waMessageId: messageId, messageType, templateName,
      })
    } catch (e) {
      logError(MODULE, 'message not recorded in the inbox; the activity and marketing touch are still written', {
        locationId: studioId, contactId: contact.id, waMessageId: messageId, stage, err: e,
      })
    }
  } else {
    logWarn(MODULE, `${c.label} thread not found or created; message not recorded in the inbox`, { locationId: studioId, contactId: contact.id })
  }

  try {
    const { error: actErr } = await db.from('activities').insert({
      contact_id: contact.id,
      location_id: studioId,
      type: ACTIVITY_TYPE,
      kind: 'event',
      subject,
      note,
    })
    if (actErr) logError(MODULE, `${c.label} activity not recorded; the daily cap undercounts it`, { locationId: studioId, contactId: contact.id, err: actErr })
  } catch (e) {
    logError(MODULE, `${c.label} activity not recorded; the daily cap undercounts it`, { locationId: studioId, contactId: contact.id, err: e })
  }

  await stampMarketingTouch(db, [contact.id], nowIso)
  return null
}

async function openerStage(ctx, { contactId, snapshot, trigger, row }) {
  const { nowMs, td, skip } = ctx

  // TRIALDONE.7 — evidence with no trigger now still has the one stored on
  // the row, so the opener is timed (and goes stale) from that.
  const timing = trigger || (row.trigger_at ? { kind: row.trigger_kind, at: row.trigger_at } : null)
  const decision = openerDecision({ trigger: timing, outreach: row, nowMs, settings: td })
  if (decision.action !== 'opener') {
    if (decision.reason === 'stale') await closeRow(ctx, row, 'stale')
    skip(decision.reason)
    return null
  }
  if (ctx.cap.sent >= ctx.cap.max) { skip('daily_cap'); return 'stop_studio' }

  const contact = await readContact(ctx, contactId)
  if (!contact) return null
  if (!(await judgeEligibility(ctx, { contact, snapshot, row }))) return null

  const gate = await sendGate(ctx, contact, { frequencyCap: true })
  if (gate) { skip(gate); return null }

  const tpl = await approvedTemplate(ctx, td.opener_template)
  if (!tpl.ok) { skip(tpl.reason); return null }
  const template = tpl.template

  const claim = await claimStage(ctx, row, 'opener')
  if (!claim.ok) { skip(claim.reason); return null }

  const sent = await sendClaimedTemplate(ctx, { row, stage: 'opener', claimAt: claim.at, contact, template })
  if (!sent) return null
  return afterSend(ctx, {
    row, stage: 'opener', contact, messageId: sent.messageId, conversationId: null,
    body: sent.body, messageType: 'template', templateName: template.name,
    subject: OPENER_SUBJECT, note: template.name,
  })
}

// ── TRIALDONE.5 — the one follow-up ──────────────────────────────────

// The ids of every studio in this studio's organisation (itself alone with
// no organisation): once per studio per tick. null = unreadable.
function orgStudioIds(ctx) {
  return once(ctx, 'org_studios', async () => {
    const { location, db } = ctx
    if (!location.organization_id) return [location.id]
    const { data, error } = await db.from('locations')
      .select('id')
      .eq('organization_id', location.organization_id)
      .order('id', { ascending: true })
      .range(0, PAGE - 1)
    if (error) {
      logError(MODULE, 'organisation studios unreadable; follow-ups skipped this tick', { locationId: location.id, err: error })
      return null
    }
    const ids = new Set((data || []).map((l) => l.id))
    ids.add(location.id)
    return [...ids]
  })
}

// The studio's thread for this number (unique (location_id, wa_phone), mig
// 008), the newest outbound on it after the opener, and the newest INBOUND
// after the opener on ANY thread of the organisation for this contact or this
// number (TRIALDONE.7: on the shared org number a reply can file at another
// studio, WAORGNUMBER.1). No thread anywhere = no reply. A failed read is a
// skip, never "no reply".
async function threadFacts(ctx, contact, openerSentAt) {
  const { db, location } = ctx
  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select(CONVERSATION_COLS)
    .eq('location_id', location.id)
    .eq('wa_phone', contact.wa_phone)
    .maybeSingle()
  if (error) {
    logError(MODULE, 'thread read failed; skipped this tick', { locationId: location.id, contactId: contact.id, err: error })
    return { ok: false, reason: 'thread_read_failed' }
  }

  const studios = await orgStudioIds(ctx)
  if (!studios) return { ok: false, reason: 'thread_read_failed' }
  const { data: threads, error: threadsErr } = await db.from('whatsapp_conversations')
    .select('id')
    .in('location_id', studios)
    .or(`contact_id.eq.${contact.id},wa_phone.eq.${contact.wa_phone}`)
    .order('id', { ascending: true })
    .range(0, PAGE - 1)
  if (threadsErr) {
    logError(MODULE, 'organisation threads unreadable; skipped this tick', { locationId: location.id, contactId: contact.id, err: threadsErr })
    return { ok: false, reason: 'thread_read_failed' }
  }
  const threadIds = (threads || []).map((t) => t.id)
  if (conversation && !threadIds.includes(conversation.id)) threadIds.push(conversation.id)

  const none = Promise.resolve({ data: [], error: null })
  const newest = (query) => query
    .gt('created_at', openerSentAt)
    .order('created_at', { ascending: false })
    .limit(1)
  const [inbound, outbound] = await Promise.all([
    threadIds.length
      ? newest(db.from('whatsapp_messages').select('created_at').in('conversation_id', threadIds).eq('direction', 'inbound'))
      : none,
    conversation
      ? newest(db.from('whatsapp_messages').select('created_at').eq('conversation_id', conversation.id).eq('direction', 'outbound'))
      : none,
  ])
  if (inbound.error || outbound.error) {
    logError(MODULE, 'thread read failed; skipped this tick', { locationId: location.id, contactId: contact.id, err: inbound.error || outbound.error })
    return { ok: false, reason: 'thread_read_failed' }
  }
  const atMs = (res) => {
    const ms = Date.parse(res.data?.[0]?.created_at ?? '')
    return Number.isFinite(ms) ? ms : null
  }
  return { ok: true, conversation, lastInboundAtMs: atMs(inbound), lastOutboundAtMs: atMs(outbound) }
}

// Mia may write on this thread: not handed to a person, not paused.
const miaOwnsThread = (conversation) => Boolean(conversation)
  && conversation.agent_active !== false && !conversation.agent_handed_off_at && !conversation.agent_paused_at

async function followupStage(ctx, { contactId, snapshot, row }) {
  const { td, nowMs, skip } = ctx

  // A closed or followed-up row needs no reads at all.
  const settled = followupDecision({ outreach: row, nowMs, settings: td })
  if (['closed', 'already_followed_up', 'no_opener'].includes(settled.reason)) { skip(settled.reason); return null }

  const contact = await readContact(ctx, contactId)
  if (!contact) return null
  if (!contact.wa_phone) { skip('no_phone'); return null }
  const thread = await threadFacts(ctx, contact, row.opener_sent_at)
  if (!thread.ok) { skip(thread.reason); return null }

  const decision = followupDecision({
    outreach: row, lastInboundAtMs: thread.lastInboundAtMs, lastOutboundAtMs: thread.lastOutboundAtMs, nowMs, settings: td,
  })
  if (!decision.action) {
    if (decision.reason === 'window_passed') await closeRow(ctx, row, 'window_passed')
    skip(decision.reason)
    return null
  }
  if (ctx.cap.sent >= ctx.cap.max) { skip('daily_cap'); return 'stop_studio' }

  if (!(await judgeEligibility(ctx, { contact, snapshot, row, closeAs: followupCloseReason }))) return null
  const kind = decision.action
  // A person has the thread: the nudge waits (the window closes the row if it stays so).
  if (kind === 'nudge' && !miaOwnsThread(thread.conversation)) { skip('mia_not_active'); return null }
  const gate = await sendGate(ctx, contact, { frequencyCap: kind === 'template' })
  if (gate) { skip(gate); return null }

  return kind === 'template'
    ? followupTemplate(ctx, { row, contact })
    : followupNudge(ctx, { row, contact, conversation: thread.conversation })
}

// They never replied: the follow-up template (outside the 24 h window).
async function followupTemplate(ctx, { row, contact }) {
  const tpl = await approvedTemplate(ctx, ctx.td.followup_template)
  if (!tpl.ok) { ctx.skip(tpl.reason); return null }
  const template = tpl.template

  const claim = await claimStage(ctx, row, 'followup', 'template')
  if (!claim.ok) { ctx.skip(claim.reason); return null }

  const sent = await sendClaimedTemplate(ctx, { row, stage: 'followup', claimAt: claim.at, contact, template })
  if (!sent) return null
  return afterSend(ctx, {
    row, stage: 'followup', contact, messageId: sent.messageId, conversationId: null,
    body: sent.body, messageType: 'template', templateName: template.name,
    subject: FOLLOWUP_SUBJECT, note: template.name,
  })
}

// They replied and went quiet: one Mia-written message inside the window, on
// the studio's own thread.
async function followupNudge(ctx, { row, contact, conversation }) {
  const { db, location, settings, zone, skip } = ctx
  const studioId = location.id

  const { data: recent, error: historyErr } = await db.from('whatsapp_messages')
    .select(HISTORY_COLS)
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_ROWS)
  if (historyErr) {
    logError(MODULE, 'thread history unreadable; skipped this tick', { locationId: studioId, contactId: contact.id, err: historyErr })
    skip('thread_read_failed')
    return null
  }

  const claim = await claimStage(ctx, row, 'followup', 'nudge')
  if (!claim.ok) { skip(claim.reason); return null }

  let composed
  try {
    const branding = await getLocationBranding(db, studioId)
    composed = await composeAgentText({
      location, settings, zone,
      historyRows: (recent || []).slice().reverse(),
      instruction: TRIAL_DONE_NUDGE_INSTRUCTION,
      companyName: branding?.companyName,
      knowledge: await loadAgentKnowledge(db, studioId),
      ...promptCapabilityFor(location, settings),
    })
  } catch (e) {
    composed = { error: `compose_threw:${e?.message || e}` }
  }
  if (!composed || composed.error) {
    await releaseStage(ctx, row, 'followup', claim.at)
    logWarn(MODULE, 'nudge not composed; claim released, the next tick retries', { locationId: studioId, contactId: contact.id, reason: String(composed?.error || 'no answer').slice(0, 200) })
    skip('nudge_compose_failed')
    return null
  }
  // Mia judged there is nothing open to pick up: the sequence ends here.
  if (!composed.text || isSkipResponse(composed.text)) {
    await closeRow(ctx, row, 'nothing_open')
    skip('nothing_open')
    return null
  }
  // parseAgentResponse scrubs em-dashes, as on every reply Mia sends.
  const parsed = parseAgentResponse(composed.text)
  if (parsed.action !== 'reply' || !parsed.text) {
    await closeRow(ctx, row, 'nudge_not_sendable')
    skip('nudge_not_sendable')
    return null
  }

  const { sendTextMessage } = await import('@/lib/whatsapp')
  let res
  try {
    res = await sendTextMessage(contact.wa_phone, parsed.text, { locationId: studioId })
  } catch (err) {
    return sendFailed(ctx, { row, stage: 'followup', claimAt: claim.at, contactId: contact.id, err })
  }
  if (!res?.messageId) return sendFailed(ctx, { row, stage: 'followup', claimAt: claim.at, contactId: contact.id, err: null })
  return afterSend(ctx, {
    row, stage: 'followup', contact, messageId: res.messageId, conversationId: conversation.id,
    body: parsed.text, messageType: 'text', templateName: null,
    subject: FOLLOWUP_SUBJECT, note: 'nudge',
  })
}
