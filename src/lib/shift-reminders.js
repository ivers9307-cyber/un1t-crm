// SHIFTREMIND.1 — shift reminders for coaches.
//
// THE RULE (one reminder per shift assignment, ever):
//   - a shift that starts BEFORE 08:00 Dublin gets its reminder at 20:00 Dublin
//     the evening before (a 2-hour lead on a 06:00 shift is a 04:00 push);
//   - every other shift gets it 2 hours before the start.
//
// WHEN IT IS DUE: from its fire time onwards, until 30 minutes before the
// shift starts. There is deliberately NO upper "late window" like the task /
// booking arms have (15 min): a shift that is published, assigned or swapped
// AFTER its fire time has passed still gets its one reminder on the next
// 5-minute tick, and missed cron ticks catch up by themselves. Under 30
// minutes' notice it is noise (the coach is already travelling, and the
// shift_adjusted / schedule_published push that created the shift has just
// told them), so it never fires then. The push_reminder_sends ledger (migs
// 169 + 619) is what makes "from the fire time onwards" send exactly once.
//
// Everything above runShiftReminders is PURE (no clock, no database) so the
// timing table in shift-reminders.test.js can pin it, DST days included.

import { localToUtc } from './push-reminders'
import { addDaysISO } from './dublin-time'
import { effectiveShiftStart } from '@shared/roster-month'

export const EARLY_START_CUTOFF = '08:00'
export const EVENING_REMINDER_TIME = '20:00'
export const DAY_LEAD_MINUTES = 120
export const MIN_NOTICE_MINUTES = 30

const DEFAULT_TZ = 'Europe/Dublin'
const MINUTE_MS = 60 * 1000
const hhmm = (t) => String(t || '').slice(0, 5)

/**
 * When does this shift's one reminder fire?
 *
 * @param {object} shift  a fetchApiShiftRows() row (src/lib/roster-read.js):
 *   shift_date, start_time_override, block_start_time, shift_templates.start_time
 * @param {string} [tz]   the location's IANA timezone
 * @returns {{ kind: 'evening_before'|'two_hours', startMs: number, fireAtMs: number, leadMinutes: number } | null}
 *   null when the row has no readable date/start (never guess a time).
 */
export function reminderPlanFor(shift, tz = DEFAULT_TZ) {
  const start = effectiveShiftStart(shift)
  if (!shift?.shift_date || !start) return null
  const startUtc = localToUtc(shift.shift_date, start, tz)
  if (!startUtc) return null
  const startMs = startUtc.getTime()

  if (hhmm(start) < EARLY_START_CUTOFF) {
    const fireUtc = localToUtc(addDaysISO(shift.shift_date, -1), EVENING_REMINDER_TIME, tz)
    if (!fireUtc) return null
    const fireAtMs = fireUtc.getTime()
    // Wall-clock 20:00 -> wall-clock start, measured in REAL minutes: 600 for
    // a 06:00 shift on a normal day, 540 / 660 across the two DST changes.
    return { kind: 'evening_before', startMs, fireAtMs, leadMinutes: Math.round((startMs - fireAtMs) / MINUTE_MS) }
  }
  return { kind: 'two_hours', startMs, fireAtMs: startMs - DAY_LEAD_MINUTES * MINUTE_MS, leadMinutes: DAY_LEAD_MINUTES }
}

/** Due = the fire time has arrived AND the shift is still >= 30 minutes away. */
export function isReminderDue(plan, nowMs) {
  if (!plan) return false
  return nowMs >= plan.fireAtMs && plan.startMs - nowMs >= MIN_NOTICE_MINUTES * MINUTE_MS
}

export const reminderKey = (assignmentId, profileId) => `${assignmentId}|${profileId}`
export const leaveKey = (profileId, dateIso) => `${profileId}|${dateIso}`

/**
 * `${profile_id}|${date}` for every (coach, date) covered by APPROVED leave.
 * Leave is a fact about the person, not the studio, so it is not filtered by
 * location: a coach on holiday at one studio is on holiday at all of them.
 */
export function leaveKeysFor(requests, dates) {
  const keys = new Set()
  for (const r of requests || []) {
    if (r?.status !== 'approved' || !r.profile_id) continue
    for (const d of dates || []) {
      if (r.start_date <= d && d <= r.end_date) keys.add(leaveKey(r.profile_id, d))
    }
  }
  return keys
}

/**
 * Which reminders are due right now? PURE.
 *
 * Re-asserts `published` and the live status even though the reader already
 * filters on both: a coach must never learn about an unpublished shift, and
 * this function is the last thing between a row and a push.
 *
 * @param {Array<object>} shifts  fetchApiShiftRows() rows
 * @param {object} ctx
 * @param {number} ctx.nowMs
 * @param {Record<string,string>} [ctx.tzByLocation]  location_id -> IANA tz
 * @param {Set<string>} [ctx.onLeave]   leaveKey() values
 * @param {Set<string>} [ctx.sentKeys]  reminderKey() values already in the ledger
 * @returns {Array<{ shift: object, kind: string, startMs: number, fireAtMs: number, leadMinutes: number }>}
 */
export function dueShiftReminders(shifts, { nowMs, tzByLocation = {}, onLeave = new Set(), sentKeys = new Set() } = {}) {
  const due = []
  // At most one reminder per (assignment, coach) in a single run too. The
  // reader returns one row per assignment id, so this never fires today; it
  // is here so that guarantee does not rest on the reader.
  const seen = new Set()
  for (const s of shifts || []) {
    if (!s?.id || !s.profile_id) continue
    if (s.published !== true) continue
    if (s.status === 'cancelled') continue // `swapped` is a live shift owned by the taker
    if (onLeave.has(leaveKey(s.profile_id, s.shift_date))) continue
    const key = reminderKey(s.id, s.profile_id)
    if (sentKeys.has(key) || seen.has(key)) continue
    const plan = reminderPlanFor(s, tzByLocation[s.location_id] || DEFAULT_TZ)
    if (!isReminderDue(plan, nowMs)) continue
    seen.add(key)
    due.push({ shift: s, ...plan })
  }
  return due
}
