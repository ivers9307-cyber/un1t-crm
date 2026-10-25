// ENTRYPOLICY.1 — the per-event entry policy for race events: the customer
// self-service switches, the hours-before cutoff, and the hold an unpaid
// entry has on its place. Two pure rules live here, each used by every gate
// that needs it so that ONE rule exists:
//
//   selfServiceBlock  why a CUSTOMER may not cancel or reschedule their own
//                     entry right now (the operator switched it off, or the
//                     cutoff has passed), with the operator's copy. Applied at
//                     every customer gate (the public entry page, Mia) and
//                     nowhere staff act.
//   holdsPlace        does this registration hold a place against capacity?
//                     confirmed always; pending_payment only while it is
//                     younger than unpaid_hold_hours; nothing else. Rows are
//                     never deleted by this rule (history and payment links
//                     stay); a lapsed entry simply stops counting.
//
// Settings live in race_events.entry_policy (jsonb, mig 767), modelled on
// race_events.find_team: a Zod schema on write, defaults filled on read, blank
// copy omitted so the defaults apply. No IO, no React/Next/Supabase.
//
// Richard's decision, 24 Oct 2026: a blocked cancel in Mia hands off to staff
// with the operator's message, never a direct cancel and never a draft
// approval request; unpaid entries stop holding places after 48 hours with no
// cron and no delete.

import { z } from 'zod'
import { zonedWallClockToInstant, strictDayStartMsIn, DEFAULT_TZ } from '@shared/zoned-time'

export const ENTRY_POLICY_DEFAULTS = Object.freeze({
  self_cancel_enabled: true,
  self_reschedule_enabled: true,
  /** Hours before the entrant's start that self-service closes. 0 = no cutoff. */
  cutoff_hours: 48,
  /** Hours an unpaid (pending_payment) entry holds its place after registering. */
  unpaid_hold_hours: 48,
  cutoff_message:
    'Changes to entries for {{event_name}} close {{hours}} hours before the start time. The team can still help: get in touch with the studio.',
  disabled_message:
    'Changes to entries for {{event_name}} are handled by the team. Get in touch with the studio and they will sort it out.',
  lapsed_message:
    'Your unpaid entry for {{event_name}} was held for {{hours}} hours and has now lapsed. You can register again if places remain.',
})

export const ENTRY_POLICY_TEXT_KEYS = Object.freeze(['cutoff_message', 'disabled_message', 'lapsed_message'])
export const ENTRY_POLICY_HOURS_MAX = 720

const copy = z.string().trim().max(2000)

/** Validates what an operator saves into race_events.entry_policy. Every key optional. */
export const EntryPolicySettingsSchema = z.object({
  self_cancel_enabled: z.boolean().optional(),
  self_reschedule_enabled: z.boolean().optional(),
  cutoff_hours: z.number().int().min(0).max(ENTRY_POLICY_HOURS_MAX).optional(),
  unpaid_hold_hours: z.number().int().min(1).max(ENTRY_POLICY_HOURS_MAX).optional(),
  cutoff_message: copy.optional(),
  disabled_message: copy.optional(),
  lapsed_message: copy.optional(),
})

function intInRange(v, min, max, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/**
 * A race_events row's entry policy with defaults filled in. Keys saved as
 * null/undefined fall back; an empty string of copy is kept (cleared on
 * purpose). Booleans always resolve to booleans and hours to integers in
 * range, so a row written by hand cannot produce an unusable policy.
 *
 * Accepts the race row (reads `entry_policy`), the saved object itself, or
 * nothing (defaults: an existing event with a null column keeps today's
 * behaviour, except that an unpaid entry older than 48 h stops counting).
 * @param {{ entry_policy?: object|null }|object|null|undefined} raceOrPolicy
 * @returns {typeof ENTRY_POLICY_DEFAULTS}
 */
export function resolveEntryPolicy(raceOrPolicy) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  let saved = {}
  if (isObj(raceOrPolicy)) {
    saved = 'entry_policy' in raceOrPolicy ? (isObj(raceOrPolicy.entry_policy) ? raceOrPolicy.entry_policy : {}) : raceOrPolicy
  }
  const out = { ...ENTRY_POLICY_DEFAULTS }
  for (const [k, v] of Object.entries(saved)) {
    if (v !== null && v !== undefined && k in ENTRY_POLICY_DEFAULTS) out[k] = v
  }
  out.self_cancel_enabled = out.self_cancel_enabled !== false
  out.self_reschedule_enabled = out.self_reschedule_enabled !== false
  out.cutoff_hours = intInRange(out.cutoff_hours, 0, ENTRY_POLICY_HOURS_MAX, ENTRY_POLICY_DEFAULTS.cutoff_hours)
  out.unpaid_hold_hours = intInRange(out.unpaid_hold_hours, 1, ENTRY_POLICY_HOURS_MAX, ENTRY_POLICY_DEFAULTS.unpaid_hold_hours)
  for (const k of ENTRY_POLICY_TEXT_KEYS) if (typeof out[k] !== 'string') out[k] = ENTRY_POLICY_DEFAULTS[k]
  return out
}

/**
 * Operator copy with `{{hours}}` and `{{event_name}}` filled in. Unknown
 * placeholders are left as written (the operator sees their own typo).
 */
export function renderEntryPolicyMessage(template, { hours, event_name } = {}) {
  return String(template ?? '')
    .replaceAll('{{hours}}', hours === null || hours === undefined ? '' : String(hours))
    .replaceAll('{{event_name}}', event_name ? String(event_name) : 'this event')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const HOUR_MS = 3_600_000

/**
 * The instant an entrant's race starts: `race_date` + the wave's `start_time`
 * on the studio's wall clock, or the start of race day when there is no wave
 * (an event with no waves). null when the event has no usable date.
 * @param {{ race_date?: string|null }} event
 * @param {{ start_time?: string|null }|null|undefined} wave
 * @param {string} zone  the event's studio zone (never a Date re-zoned)
 */
export function entryStartMs(event, wave, zone = DEFAULT_TZ) {
  const date = event?.race_date ? String(event.race_date).slice(0, 10) : null
  if (!date) return null
  const time = wave?.start_time ? String(wave.start_time).slice(0, 8) : null
  if (time) {
    const ms = zonedWallClockToInstant(date, time, zone)
    if (ms !== null) return ms
  }
  return strictDayStartMsIn(date, zone)
}

/**
 * RULE 1 — why the customer may not act on their own entry right now, or null
 * when they may. Pure. The "event day has passed" gate stays with each caller;
 * this adds the operator's two switches and the hours-before cutoff.
 *
 * @param {object} args
 * @param {object} args.event   race_events row (needs race_date, name, entry_policy)
 * @param {object|null} [args.wave]  the entrant's race_waves row (start_time); null = no waves
 * @param {number} args.nowMs
 * @param {string} [args.zone]  the event's studio zone
 * @param {'cancel'|'reschedule'} args.action
 * @returns {{ code: 'disabled'|'cutoff', message: string } | null}
 */
export function selfServiceBlock({ event, wave = null, nowMs = Date.now(), zone = DEFAULT_TZ, action }) {
  if (action !== 'cancel' && action !== 'reschedule') throw new TypeError(`selfServiceBlock: unknown action ${String(action)}`)
  const policy = resolveEntryPolicy(event)
  const vars = { hours: policy.cutoff_hours, event_name: event?.name }
  const enabled = action === 'cancel' ? policy.self_cancel_enabled : policy.self_reschedule_enabled
  if (!enabled) return { code: 'disabled', message: renderEntryPolicyMessage(policy.disabled_message, vars) }
  if (policy.cutoff_hours > 0) {
    const startMs = entryStartMs(event, wave, zone)
    if (startMs !== null && nowMs >= startMs - policy.cutoff_hours * HOUR_MS) {
      return { code: 'cutoff', message: renderEntryPolicyMessage(policy.cutoff_message, vars) }
    }
  }
  return null
}

/**
 * The instant an unpaid entry's hold ends, or null when the row is not
 * pending_payment or its registered_at cannot be read.
 */
export function unpaidHoldEndsMs(reg, policy) {
  if (reg?.status !== 'pending_payment') return null
  const at = reg.registered_at ? Date.parse(reg.registered_at) : NaN
  if (!Number.isFinite(at)) return null
  return at + resolveEntryPolicy(policy).unpaid_hold_hours * HOUR_MS
}

/**
 * RULE 2 — does this registration hold a place against capacity? Pure.
 *   confirmed        → yes
 *   pending_payment  → only while registered_at is within unpaid_hold_hours
 *                      (an unreadable registered_at keeps holding: never
 *                      oversell on a row we cannot date)
 *   anything else    → no (cancelled, no_show, placed)
 *
 * @param {{ status?: string, registered_at?: string|null }} reg
 * @param {number} nowMs
 * @param {object|null} [policy]  a resolved policy, the saved object, or the race row
 */
export function holdsPlace(reg, nowMs = Date.now(), policy = null) {
  if (reg?.status === 'confirmed') return true
  if (reg?.status !== 'pending_payment') return false
  const ends = unpaidHoldEndsMs(reg, policy)
  return ends === null ? true : nowMs < ends
}

/** A pending_payment entry whose hold has run out: never resumed, never counted. */
export function pendingLapsed(reg, nowMs = Date.now(), policy = null) {
  return reg?.status === 'pending_payment' && !holdsPlace(reg, nowMs, policy)
}

/** The rows of `regs` that hold a place (the one filter every counter uses). */
export function holdingPlaces(regs, nowMs = Date.now(), policy = null) {
  return (Array.isArray(regs) ? regs : []).filter((r) => holdsPlace(r, nowMs, policy))
}

/** The operator's lapsed sentence for an entry on `event`. */
export function lapsedMessage(event) {
  const policy = resolveEntryPolicy(event)
  return renderEntryPolicyMessage(policy.lapsed_message, { hours: policy.unpaid_hold_hours, event_name: event?.name })
}
