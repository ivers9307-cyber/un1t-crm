// src/lib/staff-push-hours.js
//
// STAFF QUIET HOURS — the ONE definition. PURE: no DB, no clock, no logging.
//
// THE RULE (absolute): a push to a member of staff that is NOT a direct
// response to that person's own action may only be SENT while the wall clock
// at their STUDIO is inside [07:00, 22:00). Outside the band the sender does
// nothing and a later tick tries again.
//
//   - The studio's clock is locations.timezone, a nullable free-text column.
//     NULL (never set) is Europe/Dublin, silently. An empty or invalid value
//     is Europe/Dublin too, and the CALLER owes one warning naming the row
//     (resolveStaffTimeZone says so with `warn`). Nothing here ever throws:
//     one bad row must not stop a cron for every coach.
//   - 07:00 is INCLUSIVE, 22:00 is EXCLUSIVE, judged on the h23 wall clock
//     (midnight is "00", never "24"), so the band is 07:00-22:00 local on the
//     23-hour and the 25-hour day alike, and both passes of the 01:00-02:00
//     hour on the autumn night are quiet.
//   - An unreadable instant is OUTSIDE the band: when in doubt, send nothing.
//
// Users: src/lib/shift-reminders.js (SHIFTREMIND.1: the shift reminder) and
// src/lib/swap-cover.js (COVERLOOP.1: manager nudges and the expiry notice).
// A new staff push that is not a reply to the recipient's own action imports
// this; it does not grow a copy. The table is staff-push-hours.test.js.
//
// NOT the customer send-time quiet hours (src/lib/send-quiet-hours.js), which
// are operator-configurable and advisory.

export const STAFF_PUSH_DEFAULT_TZ = 'Europe/Dublin'
export const STAFF_PUSH_FROM = '07:00'   // inclusive
export const STAFF_PUSH_UNTIL = '22:00'  // exclusive
export const STAFF_PUSH_HOURS = Object.freeze({ start: STAFF_PUSH_FROM, end: STAFF_PUSH_UNTIL })

// One cached Intl.DateTimeFormat per timezone string, the way push-reminders'
// localToUtc caches its own: constructing one is the expensive part of a
// wall-clock read, and a cron asks about the same handful of zones every tick.
// An INVALID zone is remembered as null, so it is only ever tried once. Keys
// are strings no longer than any IANA name; anything else never reaches it.
const MAX_TZ_LENGTH = 64
const wallClockFormatters = new Map()
function wallClockFormatterFor(tz) {
  if (!wallClockFormatters.has(tz)) {
    let fmt = null
    try {
      // hourCycle h23: midnight is "00", never "24".
      fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    } catch {
      fmt = null // not a zone Intl knows (a RangeError)
    }
    wallClockFormatters.set(tz, fmt)
  }
  return wallClockFormatters.get(tz)
}

/** Is this a timezone string Intl accepts? Empty, blank and non-strings are not. Never throws. */
export function isValidStaffTimeZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '' || tz.length > MAX_TZ_LENGTH) return false
  return !!wallClockFormatterFor(tz)
}

/**
 * The zone a studio's clock is read in, with the fallback. Never throws.
 *   valid            -> as written,     warn: false
 *   null / undefined -> Europe/Dublin,  warn: false  (never set: the default)
 *   anything else    -> Europe/Dublin,  warn: true   (the caller logs ONE warning)
 *
 * @returns {{ timeZone: string, warn: boolean }}
 */
export function resolveStaffTimeZone(tz) {
  if (isValidStaffTimeZone(tz)) return { timeZone: tz, warn: false }
  return { timeZone: STAFF_PUSH_DEFAULT_TZ, warn: tz != null }
}

/** 'HH:MM' on the h23 wall clock at `tz` (fallback applied); null for an unreadable instant. */
export function staffWallClockHHMM(ms, tz = STAFF_PUSH_DEFAULT_TZ) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const parts = wallClockFormatterFor(resolveStaffTimeZone(tz).timeZone).formatToParts(new Date(ms))
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('hour')}:${get('minute')}`
}

/** QUIET HOURS. True only while the wall clock at `tz` is inside [07:00, 22:00). */
export function inStaffPushHours(nowMs, tz = STAFF_PUSH_DEFAULT_TZ) {
  const wall = staffWallClockHHMM(nowMs, tz)
  return wall != null && wall >= STAFF_PUSH_FROM && wall < STAFF_PUSH_UNTIL
}
