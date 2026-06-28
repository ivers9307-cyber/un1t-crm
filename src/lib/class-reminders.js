// P2-7 (Part A) — pure helpers for the send-class-booking-reminders cron.
//
// Kept I/O-free so the time-window + lead-time math is fixture-testable
// without a DB. class_bookings.starts_at is a UTC timestamptz (fed straight
// from the Glofox API — unlike the legacy `bookings` table whose
// booking_date/start_time are Dublin wall-clock), so the window logic
// compares UTC instants directly; only the human time LABEL needs the
// location timezone.

import { inLeadWindow } from '@/lib/push-reminders'

// Default: one nudge 30 minutes before the class. Operators can override
// per location with notification_config.categories.class_reminder.lead_times_minutes
// (e.g. [1440, 30] for a day-before + final reminder). Bounds mirror the
// staff reminder ledger (5 min … 1 week).
export const DEFAULT_CLASS_REMINDER_LEAD_MINUTES = Object.freeze([30])
const MAX_LEAD_MINUTES = 7 * 24 * 60 // 10080

/**
 * Resolve the per-location class-reminder lead times (minutes before the
 * class start). Reads notification_config.categories.class_reminder
 * .lead_times_minutes; falls back to the default. Cleans to positive,
 * de-duplicated, in-bounds integers.
 *
 * @param {object|null} notificationConfig  locations.notification_config
 * @returns {number[]}
 */
export function resolveClassReminderLeadTimes(notificationConfig) {
  const raw = notificationConfig?.categories?.class_reminder?.lead_times_minutes
  if (!Array.isArray(raw)) return [...DEFAULT_CLASS_REMINDER_LEAD_MINUTES]
  const cleaned = []
  for (const v of raw) {
    const n = Math.round(Number(v))
    if (Number.isFinite(n) && n > 0 && n <= MAX_LEAD_MINUTES) cleaned.push(n)
  }
  const unique = [...new Set(cleaned)]
  return unique.length ? unique : [...DEFAULT_CLASS_REMINDER_LEAD_MINUTES]
}

/**
 * Pick the (booking, lead-time) pairs that are due to fire right now: a
 * class whose start is within ±windowMin of (now + leadMinutes). One
 * booking can match more than one lead time (e.g. a 24h + 30m reminder);
 * each pair dedups independently downstream.
 *
 * @param {Array<{id, contact_id, location_id?, class_name?, starts_at}>} bookings
 * @param {number} nowMs
 * @param {number[]} leadTimes  minutes-before values
 * @param {number} windowMin    half-width of the fire window (default 5)
 * @returns {Array<{bookingId, contactId, locationId, className, startsAt, leadMinutes}>}
 */
export function selectDueClassReminders(bookings, nowMs, leadTimes, windowMin = 5) {
  const out = []
  for (const b of bookings || []) {
    if (!b || !b.id || !b.contact_id || !b.starts_at) continue
    for (const lead of leadTimes || []) {
      if (inLeadWindow(b.starts_at, nowMs, lead, windowMin)) {
        out.push({
          bookingId: b.id,
          contactId: b.contact_id,
          locationId: b.location_id ?? null,
          className: b.class_name ?? null,
          startsAt: b.starts_at,
          leadMinutes: lead,
        })
      }
    }
  }
  return out
}

/**
 * Friendly local-time label for a class start, for the push body:
 * a UTC instant rendered in the location timezone as '7:30pm'.
 *
 * @param {string} startsAtIso  UTC ISO timestamp (class_bookings.starts_at)
 * @param {string} tz           IANA tz, e.g. 'Europe/Dublin'
 * @returns {string}
 */
export function classTimeLabel(startsAtIso, tz = 'Europe/Dublin') {
  const d = new Date(startsAtIso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d) // e.g. '7:30 pm'
    return s.replace(/\s+/g, '').toLowerCase() // '7:30pm'
  } catch {
    return ''
  }
}
