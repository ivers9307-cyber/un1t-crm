// INBOXFOLLOW.3 — the one nudge Mia may send on a thread a coach took over.
// Design: docs/superpowers/specs/2026-11-25-inbox-followup-queue-design.md
// ("The follow-up ladder for a thread staff took over").
//
// A coach replied, so the thread is the coach's (staff_owned_since: Mia's reply
// gate answers 'staff_owned' and she never answers on it) and the coach is
// waiting on the customer (staff_waiting_since). When the customer stays quiet
// for the studio's quiet period Q, Mia may send ONE short check-in, once, in
// the Q..Q+24h band. If the customer then replies, the thread is still the
// coach's: the reply goes to the coach and Mia stays silent. This module never
// writes staff_owned_since, staff_waiting_since, agent_active, agent_handed_off_at,
// resolved_at or a snooze; it writes staff_nudged_at / staff_nudge_outcome only.
//
// Every send is CLAIMED first (one conditional update), so a second tick, a
// customer who just replied or a coach who just completed the thread can never
// produce a second or a stale message. Silence is always explainable: each
// skip and wait logs a structured reason.
import { SKIP_PREFIX } from './prompt'
import {
  FOLLOWUP_DEFAULTS, proactiveWindowOpen, studioOwnsWhatsAppNumber, sendNudge, sendApprovedTemplate,
  lastInboundFacts, intentFlags, sentTodayCount, readStudioMarketingConsent, skipLog, readTickZones, tickSettings,
} from './followups'
import { phoneMatchesAllowlist } from './core'
import { followupConfigFromSettings } from '@/lib/inbox-followup-config'
import { isWhatsAppNumberMissing } from '@/lib/whatsapp-number-missing'
import { logError } from '@/lib/log'

const H_MS = 3600_000
const CLAIM_LEASE_MS = 30 * 60_000
const WINDOW_AFTER_QUIET_MS = 24 * H_MS
const PAGE = 100
const MAX_TEST_ROWS = 1000

export const STAFF_NUDGE_DEFAULTS = { quiet_after_hours: 48, nudge_enabled: false, template_name: null }

const STAFF_NUDGE_INSTRUCTION =
  '[STUDIO SYSTEM - not the customer] This customer was talking with a coach at the studio, who is ' +
  'waiting for their answer, and they have gone quiet. Write ONE short, warm check-in (1-2 sentences) ' +
  "that refers to the coach's last message. No selling, no new topics, no pressure, do not introduce " +
  "yourself again, and do not decide or promise anything on the coach's behalf. If the thread reads " +
  `as finished, reply with exactly ${SKIP_PREFIX} and nothing else.`

/**
 * What to do with one quiet staff-owned thread. Pure; first match wins.
 * @returns {{ action: 'wait' | 'skip' | 'template' | 'freeform', reason?: string }}
 */
export function classifyStaffNudge({
  staffWaitingSinceMs, snoozedUntilMs = null, windowExpiresAtMs = null, nowMs, quietHours,
  hasContact, optedOut, blocked, marketingConsent, sensitiveIntent, templateReady, daytimeOpen, capReached,
  customerRepliedSince = false,
} = {}) {
  if (!Number.isFinite(staffWaitingSinceMs)) return { action: 'wait', reason: 'not_due' }
  const dueAt = staffWaitingSinceMs + quietHours * H_MS
  if (nowMs < dueAt) return { action: 'wait', reason: 'not_due' }
  if (customerRepliedSince) return { action: 'skip', reason: 'customer_replied' }
  if (Number.isFinite(snoozedUntilMs)) {
    if (snoozedUntilMs > nowMs) return { action: 'wait', reason: 'snoozed' }
    if (snoozedUntilMs > dueAt) return { action: 'skip', reason: 'after_snooze' }
  }
  if (nowMs > dueAt + WINDOW_AFTER_QUIET_MS) return { action: 'skip', reason: 'expired' }
  if (!hasContact) return { action: 'skip', reason: 'no_contact' }
  if (optedOut) return { action: 'skip', reason: 'opted_out' }
  if (blocked) return { action: 'skip', reason: 'blocked' }
  if (sensitiveIntent) return { action: 'skip', reason: 'sensitive_intent' }
  if (!daytimeOpen) return { action: 'wait', reason: 'quiet_hours' }
  if (capReached) return { action: 'wait', reason: 'daily_cap' }
  if (Number.isFinite(windowExpiresAtMs) && windowExpiresAtMs > nowMs) return { action: 'freeform' }
  if (!templateReady) return { action: 'skip', reason: 'no_template' }
  if (!marketingConsent) return { action: 'skip', reason: 'no_consent' }
  return { action: 'template' }
}

const toMs = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null }

// What a failed send is called on the thread (staff_nudge_outcome 'skipped:<this>').
function outcomeReason(skipped) {
  if (/^nudge_(no_api_key|model_)/.test(skipped)) return 'compose_failed'
  if (['nothing_open', 'nudge_not_sendable'].includes(skipped)) return 'model_skip'
  if (['template_not_approved', 'no_template_configured'].includes(skipped)) return 'no_template'
  if (skipped === 'no_studio_whatsapp_consent') return 'no_consent'
  return 'send_failed'
}

const ownCols = 'id, contact_id, location_id, staff_waiting_since, staff_owned_since, snoozed_until, window_expires_at, last_message_at, last_message_direction, is_blocked, contacts!contact_id(first_name, name, wa_phone, phone, wa_status)'

// A claim that died between 'sending' and its outcome: the thread goes back to staff.
async function releaseStuckClaims(db, locationId, nowMs, results) {
  const { data, error } = await db.from('whatsapp_conversations')
    .update({ staff_nudge_outcome: 'skipped:send_failed' })
    .eq('location_id', locationId)
    .eq('staff_nudge_outcome', 'sending')
    .lt('staff_nudged_at', new Date(nowMs - CLAIM_LEASE_MS).toISOString())
    .select('id')
  if (error) return logError('staff-nudges', 'stuck claim sweep failed', { locationId, err: error })
  if (data?.length) {
    results.released += data.length
    logError('staff-nudges', 'claims stuck at sending were released as skipped:send_failed', { locationId, count: data.length })
  }
}

/**
 * One cron tick: for every location with the staff-thread nudge switched on,
 * send at most one check-in per quiet staff-owned thread. Never throws for a
 * single thread or studio.
 */
export async function runStaffThreadNudges(db, { nowMs = Date.now() } = {}) {
  const results = { freeform: 0, templates: 0, skipped: 0, waiting: 0, released: 0, outcomeWriteFailed: 0, reasons: {} }
  const note = (kind, convId, reason) => {
    results[kind]++
    results.reasons[reason] = (results.reasons[reason] || 0) + 1
    skipLog(convId, `staff_nudge_${reason}`)
  }

  const { data: locations, error: locError } = await db.from('locations')
    .select('id, name, organization_id, membership_source, settings')
    .eq('active', true)
  if (locError) { logError('staff-nudges', 'locations read failed', { err: locError }); return results }
  const zones = await readTickZones(db, locations, 'staff-nudges')
  const orgCache = new Map()

  for (const location of locations || []) {
    await releaseStuckClaims(db, location.id, nowMs, results)
    const settings = await tickSettings(db, location, orgCache)
    if (!settings) continue
    const cfg = followupConfigFromSettings(settings)
    if (!cfg.nudgeEnabled) continue
    if (!settings.enabled && !settings.test_mode) continue
    const gate = (reason) => console.warn('[radar-agent] followup-skip', JSON.stringify({ locationId: location.id, reason: `staff_nudge_${reason}` }))
    const zone = zones?.get(location.id)
    if (!zone) { gate('zone_read_failed'); continue }
    const window = proactiveWindowOpen(nowMs, settings, zone)
    if (!window.open) { gate(window.reason); continue }
    if (!(await studioOwnsWhatsAppNumber(db, location.id))) { gate('no_number'); continue }
    const templateName = settings.followups?.staff_threads?.template_name || null
    const cap = { ...FOLLOWUP_DEFAULTS, ...(settings.followups || {}) }.daily_cap
    // The shared cap: ladder sends + staff nudges (Infinity when unreadable).
    let sentToday = await sentTodayCount(db, location.id, nowMs)

    const nowIso = new Date(nowMs).toISOString()
    const candidates = () => db.from('whatsapp_conversations')
      .select(ownCols)
      .eq('location_id', location.id)
      .not('staff_waiting_since', 'is', null)
      .not('staff_owned_since', 'is', null)
      .lte('staff_waiting_since', new Date(nowMs - cfg.quietHours * H_MS).toISOString())
      .is('staff_nudged_at', null)
      .is('resolved_at', null)
      .is('agent_paused_at', null)
      .or(`snoozed_until.is.null,snoozed_until.lte.${nowIso}`)
      .order('staff_waiting_since', { ascending: true })
    // Live: one oldest-first read of 100. Test mode: strangers are never stamped
    // (that would change when their thread returns to staff), so they would
    // crowd the page; page on (up to 1,000 rows) and keep allow-listed phones only.
    let convs = []
    let convsError = null
    if (settings.enabled) {
      ;({ data: convs, error: convsError } = await candidates().limit(PAGE))
    } else {
      for (let from = 0; from < MAX_TEST_ROWS; from += PAGE) {
        const { data, error } = await candidates().range(from, from + PAGE - 1)
        if (error) { convsError = error; break }
        convs.push(...(data || []).filter((r) => {
          const ct = r.contacts || {}
          const phone = ct.wa_phone || ct.phone
          return phone && phoneMatchesAllowlist(phone, settings.test_phones)
        }))
        if ((data || []).length < PAGE) break
      }
    }
    if (convsError) { logError('staff-nudges', 'candidate query failed', { locationId: location.id, err: convsError }); continue }

    for (const c of convs || []) {
      try {
        const contact = c.contacts || {}
        const to = contact.wa_phone || contact.phone
        if (to && !settings.enabled && settings.test_mode && !phoneMatchesAllowlist(to, settings.test_phones)) {
          note('waiting', c.id, 'test_mode_not_allowlisted'); continue
        }
        // The thread itself, not the conversation row, says whether the customer
        // wrote since the coach: an inbound can land before the row is updated.
        const facts = await lastInboundFacts(db, c.id)
        if (facts.readFailed) { note('waiting', c.id, 'thread_read_failed'); continue }
        const waitingMs = toMs(c.staff_waiting_since)
        const flags = await intentFlags(db, c.id, facts.lastInboundAtMs)
        const windowOpen = (toMs(c.window_expires_at) ?? 0) > nowMs
        let marketingConsent = false
        if (!windowOpen && templateName && to) {
          const consent = await readStudioMarketingConsent(db, c)
          if (consent.error) {
            logError('staff-nudges', 'consent read failed; thread waits', { conversationId: c.id, err: consent.error })
            note('waiting', c.id, 'consent_read_failed'); continue
          }
          marketingConsent = consent.consented
        }
        const decision = classifyStaffNudge({
          staffWaitingSinceMs: waitingMs, snoozedUntilMs: toMs(c.snoozed_until), windowExpiresAtMs: toMs(c.window_expires_at),
          nowMs, quietHours: cfg.quietHours, hasContact: !!(c.contact_id && to), optedOut: contact.wa_status === 'opted_out',
          blocked: c.is_blocked === true, marketingConsent, sensitiveIntent: flags.sensitiveIntent, templateReady: !!templateName,
          daytimeOpen: true, capReached: sentToday >= cap,
          customerRepliedSince: facts.lastInboundAtMs !== null && facts.lastInboundAtMs > waitingMs,
        })
        if (decision.action === 'wait') { note('waiting', c.id, decision.reason); continue }

        // Only a thread still exactly as read may be touched: same waiting stamp, never nudged.
        const unchanged = (q) => q.eq('id', c.id).is('staff_nudged_at', null).eq('staff_waiting_since', c.staff_waiting_since)
        if (decision.action === 'skip') {
          const { error } = await unchanged(db.from('whatsapp_conversations')
            .update({ staff_nudged_at: nowIso, staff_nudge_outcome: `skipped:${decision.reason}` }))
          if (error) { logError('staff-nudges', 'skip stamp failed', { conversationId: c.id, err: error }); results.outcomeWriteFailed++ }
          note('skipped', c.id, decision.reason); continue
        }

        // CLAIM, then send only if this tick won it.
        let claim = unchanged(db.from('whatsapp_conversations')
          .update({ staff_nudged_at: nowIso, staff_nudge_outcome: 'sending' }))
          .is('resolved_at', null).is('agent_paused_at', null).not('is_blocked', 'is', true)
        claim = c.snoozed_until ? claim.eq('snoozed_until', c.snoozed_until) : claim.is('snoozed_until', null)
        const { data: won, error: claimError } = await claim.select('id')
        if (claimError) { logError('staff-nudges', 'claim failed; nothing sent', { conversationId: c.id, err: claimError }); note('waiting', c.id, 'claim_failed'); continue }
        if (!won?.length) { note('waiting', c.id, 'claim_lost'); continue }

        const conv = {
          id: c.id, contact_id: c.contact_id, location_id: c.location_id, to,
          firstName: (contact.first_name || String(contact.name || '').split(/\s+/)[0] || 'there').trim(),
        }
        let outcome
        try {
          const out = decision.action === 'freeform'
            ? await sendNudge(db, conv, location, settings, facts, zone, { instruction: STAFF_NUDGE_INSTRUCTION, stamp: false })
            : await sendApprovedTemplate(db, conv, { templateName, facts, stamp: false })
          outcome = out?.sent ? 'sent' : `skipped:${outcomeReason(out?.skipped || '')}`
        } catch (e) {
          outcome = isWhatsAppNumberMissing(e) ? 'skipped:no_number' : 'skipped:send_failed'
          logError('staff-nudges', 'send threw', { conversationId: c.id, err: e })
        }
        // Written only while the claim still stands; a reply that cleared it wins.
        const { data: wrote, error: outError } = await db.from('whatsapp_conversations')
          .update({ staff_nudge_outcome: outcome })
          .eq('id', c.id).eq('staff_nudge_outcome', 'sending').eq('staff_nudged_at', nowIso)
          .select('id')
        if (outError || !wrote?.length) {
          results.outcomeWriteFailed++
          logError('staff-nudges', 'outcome not written; the stuck-claim sweep will close it', { conversationId: c.id, outcome, err: outError || { message: 'claim no longer held' } })
        }
        if (outcome === 'sent') {
          sentToday++
          results[decision.action === 'freeform' ? 'freeform' : 'templates']++
          results.reasons.sent = (results.reasons.sent || 0) + 1
        } else note('skipped', c.id, outcome.slice('skipped:'.length))
      } catch (e) {
        results.skipped++
        logError('staff-nudges', 'thread failed', { conversationId: c.id, err: e })
      }
    }
  }
  return results
}
