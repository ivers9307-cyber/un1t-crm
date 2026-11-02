// TRIALDONE.4/.5 — the pure decisions behind the trial-done outreach (spec:
// docs/superpowers/specs/2026-10-19-hatch-trial-done-conversion-design.md).
//
// A trial finisher at a un1t.online studio gets ONE WhatsApp opener, timed
// from when they finished (trialDoneEvidenceAt: the end of the 3rd attended
// class, or the later of the trial's expiry and the 2nd class for 2 attended),
// and at most ONE follow-up after it (a template if they never replied, or a
// Mia-written in-window nudge if they replied and went quiet), only while they
// are still eligible. The runner (./trial-done-runner.js) does the reads and
// writes; these functions decide.

import { DEFAULTS } from './settings-contract'

const H_MS = 3600_000
// TRIALDONE.7 — the nudge is a free-form message, legal only inside WhatsApp's
// 24h customer-service window from their last message: nudge_max_hours is
// clamped below it whatever the setting says.
const NUDGE_MAX_HOURS_CAP = 23

/**
 * How long an opener CLAIM holds before a later tick may take it again. The
 * runner stamps opener_claimed_at BEFORE the send and opener_sent_at after
 * it; a claim older than this with no send is one that died in between, so it
 * is claimable again (CLAUDE.md, "Removing a silent failure", case c: a claim
 * before a send needs a lease). The cron runs every 15 minutes.
 */
export const TRIAL_DONE_CLAIM_LEASE_MS = 30 * 60_000

/**
 * Mia's instruction for the in-window nudge (TRIALDONE.5). It is an
 * instruction to the model, never sent to the customer as written; what she
 * writes goes through parseAgentResponse (em-dash scrub) before the send.
 * TRIALDONE.7: she may answer [[SKIP]] (a decline, a "later", nothing open),
 * which the runner closes as 'nothing_open' with nothing sent.
 */
export const TRIAL_DONE_NUDGE_INSTRUCTION = '[STUDIO SYSTEM - not the customer] They finished their trial and talked with you about continuing, then went quiet. Write one short, friendly check-in that picks up where you left off. No prices unless you already gave them. No pressure. If they declined, said they will decide later, or there is nothing open to follow up on, reply with exactly [[SKIP]] and nothing else.'

// wa_status values that mean "never message this number" (whatsapp-consent.js).
const OPTED_OUT_STATUSES = new Set(['opted_out', 'blocked', 'undeliverable'])
// shapeTrialEligibility reasons that mean they bought something.
// HATCH39 — a €39 paid trial is a purchase too (shapeTrialEligibility's paid_trial).
const PURCHASE_REASONS = new Set(['membership_history', 'paid_pack', 'paid_trial'])

/**
 * Is the opener due for this person? Pure; reads no clock but `nowMs`.
 *
 * @param {object} p
 * @param {{ kind: string, at: string }|null} p.trigger   trialDoneEvidenceAt(evidence)
 * @param {object|null} p.outreach   their trial_done_outreach row, if any
 * @param {number} p.nowMs
 * @param {object} [p.settings]      the effective trial_done block
 * @returns {{ action: 'opener' } | { action: null, reason: 'no_trigger'|'too_soon'|'stale'|'already_sent'|'closed'|'claimed' }}
 */
export function openerDecision({ trigger, outreach, nowMs, settings } = {}) {
  const s = { ...DEFAULTS.trial_done, ...(settings || {}) }
  if (outreach?.closed_at) return { action: null, reason: 'closed' }
  if (outreach?.opener_sent_at) return { action: null, reason: 'already_sent' }
  if (outreach?.opener_claimed_at) {
    const claimedMs = Date.parse(outreach.opener_claimed_at)
    if (Number.isFinite(claimedMs) && claimedMs > nowMs - TRIAL_DONE_CLAIM_LEASE_MS) {
      return { action: null, reason: 'claimed' }
    }
  }
  const atMs = trigger?.at ? Date.parse(trigger.at) : NaN
  if (!Number.isFinite(atMs)) return { action: null, reason: 'no_trigger' }
  // A trigger still in the future (the reads module reads no clock) is too soon.
  if (nowMs < atMs + Number(s.delay_hours) * H_MS) return { action: null, reason: 'too_soon' }
  if (nowMs > atMs + Number(s.stale_after_hours) * H_MS) return { action: null, reason: 'stale' }
  return { action: 'opener' }
}

/**
 * Is the one follow-up due for this person, and which kind? Pure; reads no
 * clock but `nowMs`. The runner reads the two timestamps after
 * opener_sent_at only: their last message on any of the organisation's
 * threads for them (TRIALDONE.7), the studio's last on its own thread.
 *
 * - No reply since the opener: a `template` from opener + followup_after_hours
 *   (22) to opener + followup_max_hours (30), both inclusive; after that
 *   `window_passed` (the runner closes the row).
 * - They replied: while their last message is newer than the last outbound
 *   (Mia has not answered yet) `awaiting_mia`; otherwise a `nudge` from their
 *   last message + nudge_after_hours (3) to + nudge_max_hours (20, clamped
 *   to 23 so it stays inside WhatsApp's 24h window); after that
 *   `window_passed`.
 *
 * @param {object} p
 * @param {object|null} p.outreach            their trial_done_outreach row
 * @param {number|null} [p.lastInboundAtMs]   their last message after the opener
 * @param {number|null} [p.lastOutboundAtMs]  the studio's last message after the opener
 * @param {number} p.nowMs
 * @param {object} [p.settings]               the effective trial_done block
 * @returns {{ action: 'template'|'nudge' } | { action: null, reason: 'no_opener'|'already_followed_up'|'closed'|'too_soon'|'window_passed'|'awaiting_mia' }}
 */
export function followupDecision({ outreach, lastInboundAtMs = null, lastOutboundAtMs = null, nowMs, settings } = {}) {
  const s = { ...DEFAULTS.trial_done, ...(settings || {}) }
  if (outreach?.closed_at) return { action: null, reason: 'closed' }
  const openerMs = outreach?.opener_sent_at ? Date.parse(outreach.opener_sent_at) : NaN
  if (!Number.isFinite(openerMs)) return { action: null, reason: 'no_opener' }
  if (outreach.followup_sent_at) return { action: null, reason: 'already_followed_up' }

  const replied = Number.isFinite(lastInboundAtMs) && lastInboundAtMs > openerMs
  if (!replied) {
    if (nowMs < openerMs + Number(s.followup_after_hours) * H_MS) return { action: null, reason: 'too_soon' }
    if (nowMs > openerMs + Number(s.followup_max_hours) * H_MS) return { action: null, reason: 'window_passed' }
    return { action: 'template' }
  }
  if (!Number.isFinite(lastOutboundAtMs) || lastOutboundAtMs < lastInboundAtMs) {
    return { action: null, reason: 'awaiting_mia' }
  }
  if (nowMs < lastInboundAtMs + Number(s.nudge_after_hours) * H_MS) return { action: null, reason: 'too_soon' }
  const nudgeMaxHours = Math.min(Number(s.nudge_max_hours), NUDGE_MAX_HOURS_CAP)
  if (nowMs > lastInboundAtMs + nudgeMaxHours * H_MS) return { action: null, reason: 'window_passed' }
  return { action: 'nudge' }
}

/**
 * May this person get a trial-done message right now? Pure. The first failing
 * rule names the reason, in this order: a purchase outranks a classification
 * that moved on (a buyer is no longer trial_done either, and "purchased" is
 * the reason the conversation path reads).
 *
 * @param {object} p
 * @param {string|null} p.stage                 the un1t board's classify() now
 * @param {string[]} [p.eligibilityReasons]     shapeTrialEligibility reasons
 * @param {boolean} p.activeElsewhere           an active member at another studio
 * @param {boolean} p.isStaff                   email of a live staff profile
 * @param {string|null} p.waStatus              contacts.wa_status
 * @param {boolean} p.hasConsent                the studio's whatsapp_marketing row is true
 * An input the caller did not supply (reasons not a list, activeElsewhere or
 * isStaff not a boolean) fails CLOSED with `inputs_missing`: never "eligible",
 * and the runner treats it as a defer (skip this tick), never a close.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'inputs_missing'|'not_trial_done'|'purchased'|'active_elsewhere'|'staff'|'opted_out'|'no_consent' }}
 */
export function eligibilityVerdict({ stage, eligibilityReasons, activeElsewhere, isStaff, waStatus, hasConsent } = {}) {
  if (!Array.isArray(eligibilityReasons) || typeof activeElsewhere !== 'boolean' || typeof isStaff !== 'boolean') {
    return { ok: false, reason: 'inputs_missing' }
  }
  const reasons = eligibilityReasons
  if (reasons.some((r) => PURCHASE_REASONS.has(r))) return { ok: false, reason: 'purchased' }
  if (activeElsewhere === true) return { ok: false, reason: 'active_elsewhere' }
  if (isStaff === true) return { ok: false, reason: 'staff' }
  if (stage !== 'trial_done') return { ok: false, reason: 'not_trial_done' }
  if (OPTED_OUT_STATUSES.has(waStatus)) return { ok: false, reason: 'opted_out' }
  if (hasConsent !== true) return { ok: false, reason: 'no_consent' }
  return { ok: true }
}
