// OPENWEEK.7 — the WhatsApp class reminder for open week signups (Richard,
// 19 Nov 2026). Pure rules here; the sender is open-week-reminder-send.js.
//
// When: a morning class (starting before 12:00 on the studio clock) is
// reminded at 18:00 the evening before; a lunch or afternoon class (12:00 or
// later) at 09:00 the same day. A signup after the send time still gets it, up
// to MAX_LATE_MS later and never in the last hour before the class (no
// midnight message, no "see you soon" as they walk in).
import { instantToZonedParts, addDaysISO, zonedWallClockToInstant, formatInZone } from '@/lib/location-time'

export const MORNING_CUTOFF_MINUTE = 12 * 60
export const EVENING_BEFORE = '18:00'
export const SAME_DAY = '09:00'
export const MAX_LATE_MS = 4 * 3_600_000
export const LAST_HOUR_MS = 3_600_000

/**
 * @returns {{ sendAtMs: number, dayWord: 'tomorrow'|'today' }}
 */
export function reminderPlan(startsAt, zone) {
  const parts = instantToZonedParts(startsAt, zone)
  if (parts.minuteOfDay < MORNING_CUTOFF_MINUTE) {
    return { sendAtMs: zonedWallClockToInstant(addDaysISO(parts.dateKey, -1), EVENING_BEFORE, zone), dayWord: 'tomorrow' }
  }
  return { sendAtMs: zonedWallClockToInstant(parts.dateKey, SAME_DAY, zone), dayWord: 'today' }
}

/** Due now: at or after the send time, within the late window, and not in the class's last hour. */
export function isReminderDue(plan, startMs, nowMs) {
  return nowMs >= plan.sendAtMs && nowMs - plan.sendAtMs <= MAX_LATE_MS && nowMs <= startMs - LAST_HOUR_MS
}

const TIME = Object.freeze({ hour: '2-digit', minute: '2-digit', hour12: false })

/** The template's five body values: first name, day word, time, class, studio. */
export function reminderParams({ contact, startsAt, className, studioName, zone, dayWord }) {
  const first = (contact?.first_name || '').trim() || String(contact?.name || '').trim().split(/\s+/)[0] || 'there'
  const time = formatInZone(new Date(startsAt), zone, TIME, 'en-GB')
  return [first, dayWord, time, String(className || '').trim() || 'your class', studioName || '']
}
