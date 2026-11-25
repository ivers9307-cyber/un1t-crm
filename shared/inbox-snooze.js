// Snooze presets for the staff inbox (INBOXFOLLOW.2). Pure: takes the clock and
// the studio's zone, returns instants. Every wall-clock step goes through
// shared/zoned-time, so "09:00" is the studio's 09:00, daylight saving included.

import { instantToZonedParts, addDaysIn, zonedWallClockToInstant } from './zoned-time.js'

export const SNOOZE_MAX_DAYS = 90
export const SNOOZE_NOTE_MAX = 140

const MORNING = '09:00'
const LATER_MS = 3 * 3600_000

export function snoozePresets(nowMs, zone) {
  const { dateKey, weekday } = instantToZonedParts(nowMs, zone)
  const morningOn = (days) => new Date(zonedWallClockToInstant(addDaysIn(dateKey, days, zone), MORNING, zone)).toISOString()
  // ISO weekday: Monday 1 … Sunday 7. The next Monday strictly after today.
  const daysToMonday = 8 - weekday
  return [
    { key: 'later', label: 'Later today', untilIso: new Date(nowMs + LATER_MS).toISOString() },
    { key: 'tomorrow', label: 'Tomorrow 09:00', untilIso: morningOn(1) },
    { key: 'three_days', label: 'In 3 days', untilIso: morningOn(3) },
    { key: 'next_week', label: 'Next week', untilIso: morningOn(daysToMonday) },
  ]
}

// null when `untilMs` is a valid snooze end (strictly after now, at most
// SNOOZE_MAX_DAYS ahead); otherwise the plain-words reason, for a 400.
export function snoozeUntilProblem(untilMs, nowMs) {
  if (!Number.isFinite(untilMs)) return 'Pick a valid time.'
  if (untilMs <= nowMs) return 'Pick a time in the future.'
  if (untilMs - nowMs > SNOOZE_MAX_DAYS * 24 * 3600_000) return `Pick a time within ${SNOOZE_MAX_DAYS} days.`
  return null
}
