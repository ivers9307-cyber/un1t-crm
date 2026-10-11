// challenge-countdown.js — TZ.17. "Ends in N days" for the member home screen's
// What's-next prompt. Pure (no RN imports), so it is unit-tested under vitest.
//
// `endsOn` is a calendar date ('YYYY-MM-DD', challenges.ends_on). "Today" is
// the member's day on their home studio's calendar (D7; omitted = Europe/
// Dublin). It used to be the UTC day, so from 00:00 to 01:00 Irish summer time
// the countdown said one day more than it should ("ends tomorrow" on the last day).
import { todayStrIn, DEFAULT_TZ } from 'shared/zoned-time'

const DAY_MS = 24 * 3600 * 1000

/**
 * Whole calendar days from the member's today to `endsOn` (0 = ends today,
 * negative = already ended), or null for a missing or unparseable date.
 * @param {string|null|undefined} endsOn 'YYYY-MM-DD'
 * @param {number} [nowMs]
 * @param {string} [zone] the member's home studio zone
 */
export function challengeDaysLeft(endsOn, nowMs = Date.now(), zone = DEFAULT_TZ) {
  if (!endsOn) return null
  const [y, m, d] = String(endsOn).split('-').map(Number)
  const end = Date.UTC(y, m - 1, d)
  if (!Number.isFinite(end)) return null
  const [ty, tm, td] = todayStrIn(zone || DEFAULT_TZ, nowMs).split('-').map(Number)
  return Math.round((end - Date.UTC(ty, tm - 1, td)) / DAY_MS)
}
