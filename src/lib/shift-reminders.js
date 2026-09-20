// SHIFTREMIND.1 — shift reminders for coaches.
//
// THE RULE:
//   - NOBODY IS REMINDED BEFORE 07:00 (location time). A reminder normally goes
//     2 hours before the start. If that would land before 07:00 (any start
//     before 09:00: a 2-hour lead on a 06:00 shift is a 04:00 push, on an 08:30
//     shift a 06:30 one), it goes at 20:00 the evening before instead.
//     A 09:00 start is reminded at 07:00, the earliest push of any day.
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

import { localToUtc, formatLocalTime } from './push-reminders'
import { addDaysISO, dublinDayStr } from './dublin-time'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
import { fetchApiShiftRows } from './roster-read'
import { notifyUsers } from './notify'
import { logWarn, logError } from './log'

export const NO_REMINDER_BEFORE = '07:00' // no push earlier than this, location wall-clock
export const EVENING_REMINDER_TIME = '20:00'
export const DAY_LEAD_MINUTES = 120
export const MIN_NOTICE_MINUTES = 30

const DEFAULT_TZ = 'Europe/Dublin'
const MINUTE_MS = 60 * 1000
const hhmm = (t) => String(t || '').slice(0, 5)
const minutesOfDay = (t) => { const [h, m] = hhmm(t).split(':').map(Number); return h * 60 + m }

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

  // Would "2 hours before" fall before 07:00 on the wall clock? Then the evening before.
  if (minutesOfDay(start) - DAY_LEAD_MINUTES < minutesOfDay(NO_REMINDER_BEFORE)) {
    const fireUtc = localToUtc(addDaysISO(shift.shift_date, -1), EVENING_REMINDER_TIME, tz)
    if (!fireUtc) return null
    const fireAtMs = fireUtc.getTime()
    // Wall-clock 20:00 -> wall-clock start, measured in REAL minutes: 600 for
    // a 06:00 shift on a normal day, 540 / 660 across the two DST changes
    // (so 240..839 overall, for starts 00:00..08:59).
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

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || ''
// shift_blocks is UNIQUE (location_id, template_id, block_date), so these
// three fields identify the block (the API row carries no block id).
const sameBlock = (a, b) =>
  a.location_id === b.location_id && a.shift_template_id === b.shift_template_id && a.shift_date === b.shift_date

/** First names of the OTHER coaches on the same block, A-Z, de-duplicated. */
export function coRosteredFirstNames(shift, allShifts, onLeave = new Set()) {
  const names = []
  for (const o of allShifts || []) {
    if (o.id === shift.id || o.profile_id === shift.profile_id) continue
    if (!sameBlock(o, shift)) continue
    if (o.published !== true || o.status === 'cancelled') continue
    if (onLeave.has(leaveKey(o.profile_id, o.shift_date))) continue
    const n = firstName(o.profiles?.full_name)
    if (n && !names.includes(n)) names.push(n)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

function joinNames(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Title + body. "today"/"tomorrow" is computed from the SHIFT's date against
 * the Dublin day of `nowMs`, not from the reminder kind: a catch-up reminder
 * for a 06:00 shift that fires at 05:00 must say "today".
 */
export function buildShiftReminderMessage({ shift, locationName, coNames = [], nowMs }) {
  const start = effectiveShiftStart(shift)
  const end = effectiveShiftEnd(shift)
  const today = dublinDayStr(nowMs)
  const dayWord = shift.shift_date === today
    ? 'today'
    : shift.shift_date === addDaysISO(today, 1) ? 'tomorrow' : `on ${shift.shift_date}`
  const range = end ? `${formatLocalTime(start)}-${formatLocalTime(end)}` : formatLocalTime(start)
  let body = [locationName, shift.shift_templates?.name, range].filter(Boolean).join(' · ')
  if (coNames.length) body += ` · with ${joinNames(coNames)}`
  return { title: `Shift ${dayWord} at ${formatLocalTime(start)}`, body }
}

function emptySummary() {
  return {
    shift_candidates: 0,
    shift_pushed: 0,
    shift_emailed: 0,
    shift_skipped_dup: 0,
    shift_skipped_no_recipient: 0,
    shift_send_failed: 0,
    shift_claim_failed: 0,
  }
}

// Narrow a push_reminder_sends delete/update to this shift's own ledger row.
const ownLedgerRow = (query, s) =>
  query.eq('entity_type', 'shift').eq('entity_id', s.id).eq('recipient_id', s.profile_id)

/**
 * The cron arm. Reads today's + tomorrow's PUBLISHED live shifts at every
 * location, decides what is due, and sends each reminder once.
 *
 * CLAIM BEFORE SEND, unlike the task and booking arms (send, then ledger).
 * Their late window is 15 minutes, so an unwritable ledger costs three
 * duplicates. This arm has no late window (see the header): if the ledger row
 * cannot be written (mig 619 not applied yet, a constraint, an outage), a
 * send-then-ledger order would re-send the same reminder every 5 minutes for
 * up to ten hours. So the ledger row is inserted first, the unique key
 * settles a race between two overlapping ticks, and a send that fails
 * outright RELEASES the claim so the next tick retries. The cost is CLAUDE.md's
 * "claim before send" trade: a process killed in the few milliseconds between
 * the claim and the send loses that one reminder. For a staff reminder that
 * is the right side of the trade; for a customer receipt it would not be.
 *
 * Failure posture:
 *   - shift read fails   -> throw (the route logs it; nothing was sent).
 *   - leave read fails   -> fail OPEN: a reminder to someone on holiday is
 *                           mild, a lost reminder is not.
 *   - ledger read fails  -> throw: fail CLOSED for this tick, next tick retries.
 *   - claim insert fails -> that reminder is NOT sent, logged at error level.
 *   - send fails         -> claim released, next tick retries.
 *
 * @param {object} db  service-role supabase client
 * @param {object} opts
 * @param {number} [opts.nowMs]
 * @param {Array<{id:string,name?:string,timezone?:string}>} opts.locations
 */
export async function runShiftReminders(db, { nowMs = Date.now(), locations = [] } = {}) {
  const summary = emptySummary()
  const locationIds = locations.map((l) => l.id).filter(Boolean)
  if (locationIds.length === 0) return summary

  const today = dublinDayStr(nowMs)
  const tomorrow = addDaysISO(today, 1)
  const tzByLocation = Object.fromEntries(locations.map((l) => [l.id, l.timezone || DEFAULT_TZ]))
  const nameByLocation = Object.fromEntries(locations.map((l) => [l.id, l.name || '']))

  // Two days across the estate is tens of rows, far under the 1,000-row cap.
  // publishedOnly is the D1 rule: coaches never see an unpublished shift.
  const { rows, error: shiftErr } = await fetchApiShiftRows(db, {
    locationIds, startDate: today, endDate: tomorrow, publishedOnly: true,
  })
  if (shiftErr) throw new Error(`shift read failed: ${shiftErr.message || shiftErr}`)
  if (rows.length === 0) return summary

  let onLeave = new Set()
  const profileIds = [...new Set(rows.map((r) => r.profile_id).filter(Boolean))]
  const { data: leaveRows, error: leaveErr } = await db
    .from('time_off_requests')
    .select('profile_id, start_date, end_date, status')
    .eq('status', 'approved')
    .in('profile_id', profileIds)
    .lte('start_date', tomorrow)
    .gte('end_date', today)
  if (leaveErr) logWarn('shift-reminders', 'leave read failed — reminding without the leave check', { err: leaveErr })
  else onLeave = leaveKeysFor(leaveRows, [today, tomorrow])

  const timeDue = dueShiftReminders(rows, { nowMs, tzByLocation, onLeave })
  if (timeDue.length === 0) return summary
  summary.shift_candidates = timeDue.length

  // One batched ledger read, only once something is time-due (most ticks: never).
  const { data: ledgerRows, error: ledgerErr } = await db
    .from('push_reminder_sends')
    .select('entity_id, recipient_id')
    .eq('entity_type', 'shift')
    .in('entity_id', timeDue.map((d) => d.shift.id))
  if (ledgerErr) throw new Error(`reminder ledger read failed: ${ledgerErr.message || ledgerErr}`)
  const sentKeys = new Set((ledgerRows || []).map((r) => reminderKey(r.entity_id, r.recipient_id)))

  const fresh = dueShiftReminders(rows, { nowMs, tzByLocation, onLeave, sentKeys })
  summary.shift_skipped_dup = timeDue.length - fresh.length

  for (const d of fresh) {
    const s = d.shift
    const { error: claimErr } = await db.from('push_reminder_sends').insert({
      entity_type: 'shift',
      entity_id: s.id,
      recipient_id: s.profile_id,
      lead_time_minutes: d.leadMinutes,
      push_count: 0,
      push_invalidated: 0,
    })
    if (claimErr) {
      if (claimErr.code === '23505') { summary.shift_skipped_dup++; continue } // an overlapping tick claimed it
      summary.shift_claim_failed++
      logError('shift-reminders', 'ledger claim failed — reminder NOT sent (without a ledger row it would repeat every 5 minutes)', { err: claimErr, assignment: s.id })
      continue
    }

    const { title, body } = buildShiftReminderMessage({
      shift: s,
      locationName: nameByLocation[s.location_id],
      coNames: coRosteredFirstNames(s, rows, onLeave),
      nowMs,
    })
    let result = null
    try {
      result = await notifyUsers([s.profile_id], {
        title,
        body,
        category: 'shift_reminder',
        emailSubject: title,
        data: {
          type: 'shift_reminder',
          assignment_id: s.id,
          block_date: s.shift_date,
          location_id: s.location_id,
          lead_minutes: d.leadMinutes,
        },
      })
    } catch (err) {
      logWarn('shift-reminders', 'notify threw', { err: err?.message, assignment: s.id })
    }

    const delivered = !!result && ((result.sent || 0) > 0 || (result.emailed || 0) > 0)
    if (!result || (!delivered && (result.failed || 0) > 0)) {
      summary.shift_send_failed++
      const { error: releaseErr } = await ownLedgerRow(db.from('push_reminder_sends').delete(), s)
      if (releaseErr) logError('shift-reminders', 'claim release failed — this reminder will NOT retry', { err: releaseErr, assignment: s.id })
      continue
    }

    // Diagnostics only (mig 169: push_count / push_invalidated).
    const { error: countErr } = await ownLedgerRow(db.from('push_reminder_sends').update({
      push_count: result.sent || 0,
      push_invalidated: result.invalidated || 0,
    }), s)
    if (countErr) logWarn('shift-reminders', 'ledger count update failed', { err: countErr, assignment: s.id })

    if ((result.sent || 0) > 0) summary.shift_pushed++
    else if ((result.emailed || 0) > 0) summary.shift_emailed++
    else summary.shift_skipped_no_recipient++
  }

  return summary
}
