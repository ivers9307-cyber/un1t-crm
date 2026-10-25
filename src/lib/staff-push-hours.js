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
//     NULL (never set) is DEFAULT_TZ (Europe/Dublin), silently. An empty or invalid value
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

import { DEFAULT_TZ, isValidZone, resolveZoneWithFallback, instantToZonedParts } from '@shared/zoned-time'

// TZ.8a — the zone maths is the canonical helper's (shared/zoned-time.js):
// the Dublin floor is its DEFAULT_TZ, validation is canonicalZone (any IANA
// zone; fixed offsets rejected), and the wall clock is instantToZonedParts
// (h23). These exports keep their names and shapes for their callers.
export const STAFF_PUSH_DEFAULT_TZ = DEFAULT_TZ
export const STAFF_PUSH_FROM = '07:00'   // inclusive
export const STAFF_PUSH_UNTIL = '22:00'  // exclusive
export const STAFF_PUSH_HOURS = Object.freeze({ start: STAFF_PUSH_FROM, end: STAFF_PUSH_UNTIL })

/** Is this a timezone string Intl accepts? Empty, blank and non-strings are not. Never throws. */
export function isValidStaffTimeZone(tz) {
  return isValidZone(tz)
}

/**
 * The zone a studio's clock is read in, with the fallback. Never throws.
 * A thin wrapper over resolveZoneWithFallback, in this module's old shape:
 *   valid            -> the canonical zone, warn: false
 *   null / undefined -> DEFAULT_TZ,         warn: false  (never set: the default)
 *   anything else    -> DEFAULT_TZ,         warn: true   (the caller logs ONE warning)
 *
 * @returns {{ timeZone: string, warn: boolean }}
 */
export function resolveStaffTimeZone(tz) {
  const { zone, fallback } = resolveZoneWithFallback(tz)
  return { timeZone: zone, warn: fallback }
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 'HH:MM' on the h23 wall clock at `tz` (fallback applied); null for an unreadable instant. */
export function staffWallClockHHMM(ms, tz = STAFF_PUSH_DEFAULT_TZ) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const p = instantToZonedParts(ms, resolveStaffTimeZone(tz).timeZone)
  return `${pad2(p.h)}:${pad2(p.mi)}`
}

/** QUIET HOURS. True only while the wall clock at `tz` is inside [07:00, 22:00). */
export function inStaffPushHours(nowMs, tz = STAFF_PUSH_DEFAULT_TZ) {
  const wall = staffWallClockHHMM(nowMs, tz)
  return wall != null && wall >= STAFF_PUSH_FROM && wall < STAFF_PUSH_UNTIL
}
