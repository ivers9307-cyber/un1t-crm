// PIPE3.1 — the €39 14-day trial board (UN1T Stillorgan), as a board module.
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
//
// This board only ever sees a contact the ROUTER (./router.js) sent it: one
// with a LIVE paid-trial claim, a `trial_purchases` row the person paid for.
// The clock runs from the instant Glofox granted the plan (granted_at), or
// from the payment while the grant is pending. Richard's columns, 31 Oct
// 2026: the free-trial shape with "2nd Class" replaced by "Day 7" — seven days
// into the fourteen, trained or not.
//
// Two things the acquisition classifier reads are IGNORED here on purpose:
//   • trial_credits_remaining — the 14 Day Reset lands as 10 credits, and the
//     acquisition rule files 4+ credits as a Class Pack (a sticky conversion).
//     Verified on prod 2026-10-31: the one synced buyer sat in Class Pack.
//   • pack_customer_at inside the trial window — same reason: the sync stamps
//     it minutes AFTER the grant (prod, 2026-10-30 19:48, four minutes after a
//     19:44 grant), so "a stamp after the start" is the trial's own credits.
//     A pack stamped at or after the trial's END is a conversion (FUNNEL.3)
//     and is Converted here. Ruling in the SDD ledger, Task 3.
//
// Every instant is epoch ms; no wall-clock date parsing (TZ invariant).
// Pure, no IO. Lives in shared/ so the phone can import the taxonomy.

import { countAttendedBookings } from '../pipeline-classifier.js'

export const DAY_MS = 86_400_000
/** Quiet days (no class, no payment) after the trial ends before the claim lapses. */
export const QUIET_DAYS = 60
/** Converted stays on the board this long after converted_at (the acquisition board's window). */
export const CONVERTED_WINDOW_DAYS = 60
export const DEFAULT_DURATION_DAYS = 14
export const CONVERTED_MEMBER_STATUSES = Object.freeze(['member', 'credit_member'])

// A trial_purchases row that is a claim: granted, or paid and on its way.
const PAID_PENDING_STATUSES = new Set(['queued', 'processing', 'needs_review'])

// Mirrors mig 797. Order 601+ sorts after the waitlist board's 500-block.
export const stages = Object.freeze([
  { slug: 'paid_trial_new_lead',    name: 'New Leads',  display_order: 601, color: '#3B82F6', is_dormant: false },
  { slug: 'paid_trial_first_class', name: '1st Class',  display_order: 602, color: '#10B981', is_dormant: false },
  { slug: 'paid_trial_day_7',       name: 'Day 7',      display_order: 603, color: '#8B5CF6', is_dormant: false },
  { slug: 'paid_trial_done',        name: 'Trial Done', display_order: 604, color: '#F59E0B', is_dormant: false },
  { slug: 'paid_trial_converted',   name: 'Converted',  display_order: 605, color: '#059669', is_dormant: false },
])

// The acquisition set: the router runs classifyContact() on the same row to
// find Cold and Gympass before any claim is considered.
export const requiredFields = Object.freeze([
  'id',
  'name',
  'email',
  'glofox_membership_status',
  'glofox_membership_state',
  'glofox_membership_expiry',
  'last_attended_at',
  'total_attended_7d',
  'total_attended_30d',
  'last_payment_at',
  'joined_at',
  'created_at',
  'trial_credits_remaining',
  'recent_bookings',
  'converted_at',
  'pack_customer_at',
  'pipeline_dismissed_at',
  'gympass_member_id',
  'last_lead_source_at',
])

const parseMs = (iso) => {
  if (iso == null) return null
  const ms = typeof iso === 'number' ? iso : Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The live paid-trial claim behind a contact's trial_purchases rows, or null.
 * @param {Array<{status:string, payment_status?:string|null, paid_at?:string|null, granted_at?:string|null, duration_days?:number|null}>|null} purchases
 * @param {number} _now  epoch ms (unused today; kept so callers pass the run instant)
 * @returns {{ start:number, end:number, paidAt:number|null, grantedAt:number|null, durationDays:number }|null}
 */
export function paidTrialClaim(purchases, _now = Date.now()) {
  if (!Array.isArray(purchases)) return null
  let best = null
  for (const p of purchases) {
    if (!p) continue
    const counts = p.status === 'granted'
      || (p.payment_status === 'paid' && PAID_PENDING_STATUSES.has(p.status))
    if (!counts) continue
    const grantedAt = parseMs(p.granted_at)
    const paidAt = parseMs(p.paid_at)
    const start = grantedAt ?? paidAt
    if (start == null) continue
    const durationDays = Number.isFinite(Number(p.duration_days)) && Number(p.duration_days) > 0
      ? Number(p.duration_days) : DEFAULT_DURATION_DAYS
    const claim = { start, end: start + durationDays * DAY_MS, paidAt, grantedAt, durationDays }
    if (!best || claim.start > best.start) best = claim
  }
  return best
}

/** Attended classes at or after `sinceMs` (recent_bookings, floored on last_attended_at). */
export function attendedSince(contact, sinceMs) {
  if (!contact || typeof contact !== 'object') return 0
  const bookings = Array.isArray(contact.recent_bookings)
    ? contact.recent_bookings.filter((b) => b && Number.isFinite(Number(b.time_start)) && Number(b.time_start) * 1000 >= sinceMs)
    : []
  const counted = countAttendedBookings(bookings)
  const lastMs = parseMs(contact.last_attended_at)
  return Math.max(counted, lastMs != null && lastMs >= sinceMs ? 1 : 0)
}

/** A member status at any time, or a Class Pack stamped at/after `packSinceMs`. */
export function convertedSince(contact, packSinceMs) {
  if (!contact || typeof contact !== 'object') return false
  if (CONVERTED_MEMBER_STATUSES.includes(contact.glofox_membership_status)) return true
  const packMs = parseMs(contact.pack_customer_at)
  return packMs != null && packMs >= packSinceMs
}

/** The later of last_attended_at and last_payment_at, or null. */
export function lastActivityMs(contact) {
  if (!contact || typeof contact !== 'object') return null
  const a = parseMs(contact.last_attended_at)
  const p = parseMs(contact.last_payment_at)
  if (a == null && p == null) return null
  return Math.max(a ?? -Infinity, p ?? -Infinity)
}

/**
 * Is the claim still this person's board? Converted: 60 days from converted_at
 * (or the last activity when the stamp is missing). Otherwise: 60 quiet days
 * from the later of the trial's end and their last class or payment.
 */
export function claimLive(claim, contact, now = Date.now()) {
  if (!claim) return false
  const activity = lastActivityMs(contact)
  if (convertedSince(contact, claim.end)) {
    const since = parseMs(contact?.converted_at) ?? Math.max(claim.start, activity ?? claim.start)
    return now - since < CONVERTED_WINDOW_DAYS * DAY_MS
  }
  const quietFrom = Math.max(claim.end, activity ?? 0)
  return now - quietFrom < QUIET_DAYS * DAY_MS
}

/**
 * The €39 board's column for a contact with a live claim.
 * @returns {string} stage slug
 */
export function classify(contact, now = Date.now(), claim = null) {
  if (!claim) throw new TypeError('paid-trial classify needs a live claim')
  if (convertedSince(contact, claim.end)) return 'paid_trial_converted'
  if (now >= claim.end) return 'paid_trial_done'
  if (now >= claim.start + 7 * DAY_MS) return 'paid_trial_day_7'
  if (attendedSince(contact, claim.start) >= 1) return 'paid_trial_first_class'
  return 'paid_trial_new_lead'
}
