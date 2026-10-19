// TRIALDONE.4 — the pure decisions behind the trial-done outreach (spec:
// docs/superpowers/specs/2026-10-19-hatch-trial-done-conversion-design.md).
//
// A trial finisher at a un1t.online studio gets ONE WhatsApp opener, timed
// from when they finished (trialDoneEvidenceAt: the end of the 3rd attended
// class, or the later of the trial's expiry and the 2nd class for 2 attended),
// and only while they are still eligible. The runner
// (./trial-done-runner.js) does the reads and writes; these functions decide.

import { DEFAULTS } from './settings-contract'

const H_MS = 3600_000

/**
 * How long an opener CLAIM holds before a later tick may take it again. The
 * runner stamps opener_claimed_at BEFORE the send and opener_sent_at after
 * it; a claim older than this with no send is one that died in between, so it
 * is claimable again (CLAUDE.md, "Removing a silent failure", case c: a claim
 * before a send needs a lease). The cron runs every 15 minutes.
 */
export const TRIAL_DONE_CLAIM_LEASE_MS = 30 * 60_000

// wa_status values that mean "never message this number" (whatsapp-consent.js).
const OPTED_OUT_STATUSES = new Set(['opted_out', 'blocked', 'undeliverable'])
// shapeTrialEligibility reasons that mean they bought something.
const PURCHASE_REASONS = new Set(['membership_history', 'paid_pack'])

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
 * @returns {{ ok: true } | { ok: false, reason: 'not_trial_done'|'purchased'|'active_elsewhere'|'staff'|'opted_out'|'no_consent' }}
 */
export function eligibilityVerdict({ stage, eligibilityReasons, activeElsewhere, isStaff, waStatus, hasConsent } = {}) {
  const reasons = Array.isArray(eligibilityReasons) ? eligibilityReasons : []
  if (reasons.some((r) => PURCHASE_REASONS.has(r))) return { ok: false, reason: 'purchased' }
  if (activeElsewhere === true) return { ok: false, reason: 'active_elsewhere' }
  if (isStaff === true) return { ok: false, reason: 'staff' }
  if (stage !== 'trial_done') return { ok: false, reason: 'not_trial_done' }
  if (OPTED_OUT_STATUSES.has(waStatus)) return { ok: false, reason: 'opted_out' }
  if (hasConsent !== true) return { ok: false, reason: 'no_consent' }
  return { ok: true }
}
