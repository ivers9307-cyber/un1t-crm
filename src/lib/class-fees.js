// FEES.1 — late-cancellation and no-show fees at un1t.online studios: the
// pure rules. No db, no fetch, no clock of its own (every "now" is passed in).
//
// The flow (Richard, 28 Oct 2026; docs plan for-studios-running-un1t-online):
// - 23:00 studio time: every no-show and every late cancellation of the
//   day's classes becomes a class_fees row; the review contacts get an email.
// - Staff may waive any fee until it is charged.
// - 17:00 the next day: each fee not waived is charged to the member's
//   default card through un1t.online charge-custom, described by the class.
// - Refused: one more try 7 days later; refused again: OUTSTANDING on the
//   member's profile, where staff can retry or waive.
// - A pack member whose credit un1t.online already kept (a no-show, or a
//   cancel inside un1t.online's own window) is only recorded.
//
// "Late" is un1t.online's own window (studio default_cancelation_window_hours,
// read live), never a CRM setting: members see one rule.

import { formatInZone, dateKeyIn, addDaysIn, zonedWallClockToInstant, instantToZonedParts } from './location-time.js'
import { classForgivenessFrom } from './class-fees-forgiveness.js'

export const CLASS_FEE_KINDS = Object.freeze(['late_cancel', 'no_show'])
export const CLASS_FEE_STATUSES = Object.freeze(['pending', 'waived', 'charging', 'charged', 'retry_scheduled', 'outstanding', 'recorded'])
/** A fee is owed (and shows on the profile) in these statuses. */
export const OPEN_FEE_STATUSES = Object.freeze(['pending', 'charging', 'retry_scheduled', 'outstanding'])
/** Staff may waive from these; never once charging or charged. */
export const WAIVABLE_STATUSES = Object.freeze(['pending', 'retry_scheduled', 'outstanding'])
/** Staff may retry the charge from these. */
export const RETRYABLE_STATUSES = Object.freeze(['retry_scheduled', 'outstanding'])

export const CLASS_FEE_DEFAULTS = Object.freeze({
  detectHour: 23,
  chargeHour: 17,
  retryDays: 7,
  // A charging claim older than this is resumed with the same key.
  staleChargingMs: 15 * 60_000,
})

// Hard ceiling on one fee, in cents (mirrors class_fees_amount_check).
export const MAX_FEE_CENTS = 100_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hourOr = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d)
const centsOr0 = (v) => (Number.isInteger(v) && v > 0 && v <= MAX_FEE_CENTS ? v : 0)

/**
 * locations.settings.un1t_online.fees → the fee settings. Pure; anything
 * unreadable is off. Only the literal true turns `enabled` on.
 * @returns {{ enabled: boolean, chargingPaused: boolean, lateCancelFeeCents: number,
 *   noShowFeeCents: number, reviewEmails: string[], detectHour: number, chargeHour: number,
 *   retryDays: number, forgiveness: ReturnType<typeof classForgivenessFrom> }}
 */
export function classFeeSettingsFrom(settings) {
  const block = isObj(settings) && isObj(settings.un1t_online) && isObj(settings.un1t_online.fees)
    ? settings.un1t_online.fees
    : {}
  const emails = Array.isArray(block.review_emails) ? block.review_emails : []
  return {
    enabled: block.enabled === true,
    // A missing pause flag is NOT paused, but `enabled` defaults off.
    chargingPaused: block.charging_paused === true,
    lateCancelFeeCents: centsOr0(block.late_cancel_fee_cents),
    noShowFeeCents: centsOr0(block.no_show_fee_cents),
    reviewEmails: [...new Set(emails
      .filter((e) => typeof e === 'string')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e)))].slice(0, 10),
    detectHour: hourOr(block.detect_hour, CLASS_FEE_DEFAULTS.detectHour),
    chargeHour: hourOr(block.charge_hour, CLASS_FEE_DEFAULTS.chargeHour),
    retryDays: CLASS_FEE_DEFAULTS.retryDays,
    forgiveness: classForgivenessFrom(block),
  }
}

const statusOf = (v) => String(v ?? '').trim().toLowerCase()
const isCancelled = (s) => s === 'cancelled' || s === 'canceled'
const msOf = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v ?? ''))

/**
 * What one booking of a class that has started means.
 *
 * @param {{ status: string, cancelled_at?: string|null }} booking un1t_bookings row
 * @param {{ starts_at: string, status?: string|null }} event un1t_events row
 * @param {{ windowHours: number, nowMs: number, staffCancelled?: boolean }} ctx
 * @returns {{ kind: 'no_show'|'late_cancel', minutesBeforeStart: number|null, cancelledAt: string|null }
 *   | { undecided: true } | null}
 *   null = nothing to charge (attended, cancelled in time, class not started,
 *   class cancelled, a staff cancel, an unreadable row).
 */
export function classifyBooking(booking, event, { windowHours, nowMs, staffCancelled = false }) {
  if (!isObj(booking) || !isObj(event)) return null
  const startMs = msOf(event.starts_at)
  if (!Number.isFinite(startMs) || startMs > nowMs) return null
  if (isCancelled(statusOf(event.status))) return null
  const s = statusOf(booking.status)
  if (s === 'no_show') return { kind: 'no_show', minutesBeforeStart: null, cancelledAt: null }
  if (s === 'booked') return { undecided: true }
  if (!isCancelled(s) || staffCancelled) return null
  // Without a readable window or cancel time nothing is late: never guess a fee.
  if (!Number.isFinite(windowHours) || windowHours <= 0) return null
  const cancelMs = msOf(booking.cancelled_at)
  if (!Number.isFinite(cancelMs)) return null
  const minutesBefore = Math.round((startMs - cancelMs) / 60_000)
  if (startMs - cancelMs >= windowHours * 3_600_000) return null
  return { kind: 'late_cancel', minutesBeforeStart: minutesBefore, cancelledAt: new Date(cancelMs).toISOString() }
}

/**
 * The penalty for one offence. An unlimited member pays the fee; a booking
 * that spent a credit loses it (un1t.online keeps a credit inside its window
 * and on a no-show), which is only recorded; any other booking pays the fee.
 * @param {{ credit_charged?: boolean|null }} booking
 * @param {{ credit_unlimited?: boolean|null }|null} client un1t_clients row
 * @returns {'fee'|'credit_forfeit'}
 */
export function penaltyFor(booking, client) {
  if (client?.credit_unlimited === true) return 'fee'
  return booking?.credit_charged === true ? 'credit_forfeit' : 'fee'
}

const KIND_LABEL = Object.freeze({ late_cancel: 'Late cancellation', no_show: 'No-show' })
export const classFeeKindLabel = (kind) => KIND_LABEL[kind] ?? 'Class fee'

/**
 * The charge description the member sees on their un1t.online receipt:
 * "Late cancellation: HYROX Engine, Tue 28 Oct 2026, 18:30". Max 200 chars.
 */
export function feeDescription({ kind, classTitle, startsAt, zone }) {
  const title = typeof classTitle === 'string' && classTitle.trim() ? classTitle.trim() : 'Class'
  const day = formatInZone(startsAt, zone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const time = formatInZone(startsAt, zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${classFeeKindLabel(kind)}: ${title}, ${day.replace(/,/g, '')}, ${time}`.slice(0, 200)
}

/** The local hour (0-23) of an instant in `zone`. */
export const localHourIn = (nowMs, zone) => instantToZonedParts(nowMs, zone).h

/**
 * The first `hour`:00 local strictly after `fromMs` + `minLeadMs`, as an
 * ISO instant. With the defaults, a fee found at 23:00 is due 17:00 the next day.
 */
export function nextLocalHourAfter(fromMs, hour, zone, { minLeadMs = 60 * 60_000 } = {}) {
  const earliest = fromMs + minLeadMs
  let day = dateKeyIn(fromMs, zone)
  for (let i = 0; i < 3; i++) {
    const ms = zonedWallClockToInstant(day, `${String(hour).padStart(2, '0')}:00`, zone)
    if (ms != null && ms >= earliest) return new Date(ms).toISOString()
    day = addDaysIn(day, 1, zone)
  }
  return new Date(earliest).toISOString()
}

/** The retry instant: `days` local days after `fromMs`, at `hour`:00 local. */
export function retryAtAfter(fromMs, days, hour, zone) {
  const day = addDaysIn(dateKeyIn(fromMs, zone), days, zone)
  const ms = zonedWallClockToInstant(day, `${String(hour).padStart(2, '0')}:00`, zone)
  return new Date(ms ?? fromMs + days * 86_400_000).toISOString()
}

/**
 * The class_fees row for one offence (insert shape; status pending or
 * recorded). amount 0 for a fee kind means the studio set no amount: no row.
 * @returns {object|null}
 */
export function buildFeeRow({ locationId, contactId, booking, event, classified, penalty, settings, zone, nowMs }) {
  const base = {
    location_id: locationId,
    contact_id: contactId ?? null,
    un1t_user_id: booking.un1t_user_id,
    un1t_booking_id: booking.un1t_id,
    un1t_event_id: event.un1t_id,
    class_title: event.title ?? null,
    starts_at: event.starts_at,
    class_day: dateKeyIn(event.starts_at, zone),
    kind: classified.kind,
    cancelled_at: classified.cancelledAt,
    minutes_before_start: classified.minutesBeforeStart,
    penalty,
  }
  if (penalty === 'credit_forfeit') {
    return { ...base, amount_cents: 0, charge_description: null, status: 'recorded' }
  }
  const amount = classified.kind === 'no_show' ? settings.noShowFeeCents : settings.lateCancelFeeCents
  if (!(amount > 0)) return null
  return {
    ...base,
    amount_cents: amount,
    currency: 'eur',
    charge_description: feeDescription({ kind: classified.kind, classTitle: event.title, startsAt: event.starts_at, zone }),
    status: 'pending',
    charge_due_at: nextLocalHourAfter(nowMs, settings.chargeHour, zone),
  }
}

/**
 * The row patch after one charge attempt. `result` is the Un1tWriteResult of
 * chargeClassFee; `prevStatus` the status the fee was claimed from.
 * @returns {object} class_fees columns to write, plus `releaseAttempt: true`
 *   (not a column: strip it) when the attempt number must be handed back
 */
export function patchAfterCharge(result, { prevStatus, origin, nowMs, settings, zone }) {
  const now = new Date(nowMs).toISOString()
  if (result?.verdict === 'done' && result.id) {
    return {
      status: 'charged', charged_at: now, un1t_transaction_id: String(result.id),
      failure_code: null, failure_message: null, next_attempt_at: null, charge_started_at: null,
    }
  }
  const failure = {
    failure_code: (result?.code ?? null) && String(result.code).slice(0, 100),
    failure_message: result?.message ? String(result.message).slice(0, 500) : null,
  }
  if (result?.verdict === 'refused' && !result.retryable) {
    // The first automatic refusal earns one more try in `retryDays`; a staff
    // retry of a fee already scheduled keeps its schedule; anything else is
    // outstanding.
    if (origin === 'fee_run' && prevStatus === 'pending') {
      return { ...failure, status: 'retry_scheduled', next_attempt_at: retryAtAfter(nowMs, settings.retryDays, settings.chargeHour, zone), charge_started_at: null }
    }
    if (origin === 'staff' && prevStatus === 'retry_scheduled') {
      return { ...failure, status: 'retry_scheduled', charge_started_at: null }
    }
    return { ...failure, status: 'outstanding', next_attempt_at: null, charge_started_at: null }
  }
  if (result?.verdict === 'refused') {
    // Nothing was charged and the refusal is ours or passing (switch, budget,
    // throttle, an attempt already in flight): back where it came from, and the
    // caller hands the attempt number back, so the next try reuses its key.
    return { ...failure, status: prevStatus, charge_started_at: null, releaseAttempt: true }
  }
  // unknown: stays charging; the next run resumes the SAME idempotency key.
  return { ...failure, status: 'charging' }
}
