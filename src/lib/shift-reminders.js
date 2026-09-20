// SHIFTREMIND.1 — shift reminders for coaches.
//
// THE RULE:
//   - ONE REMINDER PER RUN OF SHIFTS, NOT PER SHIFT. A coach's live, published
//     shifts for a date, across ALL locations, are sorted by effective start
//     and grouped into runs: a shift joins the current run when it starts no
//     more than 120 minutes (RUN_GAP_MINUTES) after the run's LATEST end
//     (overlaps and back-to-back included); otherwise it opens a new run.
//     05:45-08:00 + 08:00-09:00 + 09:15-10:30 is one run and one push; a split
//     day (morning + evening) is two. Only the run's FIRST shift carries the
//     reminder, timed by that shift's start; the message describes the run.
//   - QUIET HOURS, A HARD RULE: a reminder is only ever SENT while the wall
//     clock (location time, Europe/Dublin today) is inside [07:00, 22:00):
//     NO_REMINDER_BEFORE / NO_REMINDER_FROM. Outside that band nothing is due,
//     full stop, whatever the reason the reminder is late (published at 23:30,
//     a send failing and retrying, a ledger outage ending, mig 619 applied at
//     night). It is tested on NOW, in the pure function, and runShiftReminders
//     returns before any database read.
//   - PLANNED TIME: 2 hours before the start (DAY_LEAD_MINUTES). If that would
//     land before 07:00, i.e. any start before 09:00 (a 2-hour lead on a 06:00
//     shift is a 04:00 push, on an 08:30 shift a 06:30 one), it is planned for
//     20:00 the evening before instead. A 09:00 start is reminded at 07:00.
//     Every planned time is inside the band (the latest, for a 23:59 start, is
//     21:59).
//   - ACCEPTED CONSEQUENCE of quiet hours: a run whose reminder could not be
//     sent before 22:00 (published or assigned late in the evening, or delivery
//     failing until 22:00) gets NO reminder if it starts before 07:30 the next
//     morning; the assign / publish push has already told that coach. A run
//     starting 07:30 or later is still reminded from 07:00, as long as 30+
//     minutes remain.
//   - Whole-day approved leave skips the coach's day. A HALF day (single-day
//     request, total_days < 1) does not: the table does not say which half.
//
// ONCE PER RUN, VIA THE LEDGER YOU ALREADY HAVE: the claim is keyed on the
// first shift's (assignment, coach). A run counts as reminded when the ledger
// holds a claim for that coach on ANY of its shifts, so:
//   - a shift added to a reminded run, later OR earlier than its first shift,
//     does not re-remind (the shift_adjusted push has told the coach);
//   - a first shift SWAPPED AWAY after the reminder went still marks the run
//     reminded for the giver: the row still exists (now the taker's), so it
//     stands in the giver's day as a "ghost" (buildShiftRuns). The taker is
//     reminded for their own run.
//   - ACCEPTED, NOT HANDLED: a first shift REMOVED after the reminder went. A
//     manager unassign is a hard DELETE (src/lib/shift-unassign.js), and the
//     ledger row records no date, times or run, so nothing is left to mark the
//     rest of the run as reminded: it is reminded ONCE more, keyed on its new
//     first shift (the coach's day now starts at a different time, so the
//     extra reminder carries the corrected start). Closing this would need a
//     schema change (a run/date column on the ledger). Pinned by a test.
//
// WHEN IT IS DUE: outside quiet hours, from its planned time onwards, until 30
// minutes before the run starts. There is deliberately NO upper "late window" like the task /
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
import { addDaysISO, dublinDayStr } from './dublin-time'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
import { fetchApiShiftRows } from './roster-read'
import { notifyUsers } from './notify'
import { logWarn, logError } from './log'

// QUIET HOURS: a reminder may only be SENT while the location's wall clock is
// inside [NO_REMINDER_BEFORE, NO_REMINDER_FROM). Outside it nothing is due.
export const NO_REMINDER_BEFORE = '07:00'
export const NO_REMINDER_FROM = '22:00'
export const EVENING_REMINDER_TIME = '20:00'
export const DAY_LEAD_MINUTES = 120
export const MIN_NOTICE_MINUTES = 30
export const BODY_MAX_CHARS = 140 // roughly what a lock screen shows before it cuts the body
export const MAX_CO_NAMES = 3
export const LEDGER_LOOKBACK_HOURS = 48
export const RUN_GAP_MINUTES = 120 // a shift starting within this of the run's latest end is the same run

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

const wallClockFormatters = new Map()
function wallClockHHMM(ms, tz) {
  if (!wallClockFormatters.has(tz)) {
    // hourCycle h23: midnight is "00", never "24".
    wallClockFormatters.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
  }
  const parts = wallClockFormatters.get(tz).formatToParts(new Date(ms))
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('hour')}:${get('minute')}`
}

/** QUIET HOURS. True only while the wall clock at `tz` is inside [07:00, 22:00). */
export function isInSendWindow(nowMs, tz = DEFAULT_TZ) {
  const wall = wallClockHHMM(nowMs, tz)
  return wall >= NO_REMINDER_BEFORE && wall < NO_REMINDER_FROM
}

/**
 * Due = it is not quiet hours, the fire time has arrived, AND the shift is
 * still >= 30 minutes away. The quiet-hours test is on NOW, not on the planned
 * fire time: a planned time is always inside the window, but a catch-up (late
 * publish, a failed send retrying, a ledger outage ending) can land anywhere.
 */
export function isReminderDue(plan, nowMs, tz = DEFAULT_TZ) {
  if (!plan) return false
  if (!isInSendWindow(nowMs, tz)) return false
  return nowMs >= plan.fireAtMs && plan.startMs - nowMs >= MIN_NOTICE_MINUTES * MINUTE_MS
}

export const reminderKey = (assignmentId, profileId) => `${assignmentId}|${profileId}`
export const leaveKey = (profileId, dateIso) => `${profileId}|${dateIso}`

// A HALF day: a single-day request whose total_days (numeric(5,1), mig 011) is
// under 1. The table does not record WHICH half, so the coach may be working
// the other one: a half day never silences a reminder. An unreadable total is
// treated as a full day (the behaviour before half days were considered).
function isHalfDay(r) {
  if (r.start_date !== r.end_date) return false
  const total = Number(r.total_days)
  return r.total_days != null && Number.isFinite(total) && total < 1
}

/**
 * `${profile_id}|${date}` for every (coach, date) covered by APPROVED leave
 * for the WHOLE day (single full days and every day of a multi-day request;
 * half days excluded, see isHalfDay).
 * Leave is a fact about the person, not the studio, so it is not filtered by
 * location: a coach on holiday at one studio is on holiday at all of them.
 */
export function leaveKeysFor(requests, dates) {
  const keys = new Set()
  for (const r of requests || []) {
    if (r?.status !== 'approved' || !r.profile_id) continue
    if (isHalfDay(r)) continue
    for (const d of dates || []) {
      if (r.start_date <= d && d <= r.end_date) keys.add(leaveKey(r.profile_id, d))
    }
  }
  return keys
}

const isLivePublished = (s) => !!s?.id && !!s.profile_id && s.published === true && s.status !== 'cancelled'

/** A shift's real [start, end] instants. An end at or before the start is the NEXT day (overnight). */
function shiftWindow(shift, tz) {
  const start = effectiveShiftStart(shift)
  if (!shift?.shift_date || !start) return null
  const startUtc = localToUtc(shift.shift_date, start, tz)
  if (!startUtc) return null
  const startMs = startUtc.getTime()
  const end = effectiveShiftEnd(shift)
  if (!end) return { startMs, endMs: startMs }
  let endUtc = localToUtc(shift.shift_date, end, tz)
  if (endUtc && endUtc.getTime() < startMs) endUtc = localToUtc(addDaysISO(shift.shift_date, 1), end, tz)
  return { startMs, endMs: endUtc ? Math.max(endUtc.getTime(), startMs) : startMs }
}

/**
 * Group every coach's live, published shifts for a date into RUNS. PURE.
 *
 * Sorted by effective start, a shift joins the current run when it starts no
 * more than RUN_GAP_MINUTES after the run's LATEST end (overlaps and
 * back-to-back included); otherwise it opens a new run. Runs are per coach and
 * per shift date, across ALL locations. A coach on whole-day leave has no runs
 * that day.
 *
 * `reminded` is true when the ledger already holds a reminder for this coach
 * on ANY shift of the run, including a GHOST: a shift of that date that the
 * coach was reminded about and that now belongs to someone else (swapped
 * away). The ghost sits in the coach's day only to mark its run as reminded;
 * it is never in `shifts` and never carries a reminder.
 *
 * @returns {Array<{ profileId: string, date: string, shifts: object[], first: object,
 *   startMs: number, endMs: number, reminded: boolean }>}
 */
export function buildShiftRuns(shifts, { tzByLocation = {}, onLeave = new Set(), sentKeys = new Set() } = {}) {
  // One entry per assignment id whatever the input: the reader returns one row
  // per id, and this does not rely on that.
  const byId = new Map()
  for (const s of shifts || []) {
    if (!isLivePublished(s) || byId.has(s.id)) continue
    const win = shiftWindow(s, tzByLocation[s.location_id] || DEFAULT_TZ)
    if (win) byId.set(s.id, { shift: s, ...win })
  }
  const all = [...byId.values()]

  const groups = new Map()
  for (const item of all) {
    const key = leaveKey(item.shift.profile_id, item.shift.shift_date)
    if (onLeave.has(key)) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  const runs = []
  for (const own of groups.values()) {
    const { profile_id: profileId, shift_date: date } = own[0].shift
    const ghosts = all
      .filter((i) => i.shift.profile_id !== profileId && i.shift.shift_date === date && sentKeys.has(reminderKey(i.shift.id, profileId)))
      .map((i) => ({ ...i, ghost: true }))
    const items = [...own, ...ghosts].sort((a, b) =>
      a.startMs - b.startMs || a.endMs - b.endMs || String(a.shift.id).localeCompare(String(b.shift.id)))

    let current = null
    const close = () => {
      const real = current.items.filter((i) => !i.ghost)
      if (real.length === 0) return
      runs.push({
        profileId,
        date,
        shifts: real.map((i) => i.shift),
        first: real[0].shift,
        startMs: real[0].startMs,
        endMs: Math.max(...real.map((i) => i.endMs)),
        reminded: current.items.some((i) => i.ghost || sentKeys.has(reminderKey(i.shift.id, profileId))),
      })
    }
    for (const item of items) {
      if (current && item.startMs <= current.endMs + RUN_GAP_MINUTES * MINUTE_MS) {
        current.items.push(item)
        current.endMs = Math.max(current.endMs, item.endMs)
      } else {
        if (current) close()
        current = { items: [item], endMs: item.endMs }
      }
    }
    if (current) close()
  }
  return runs
}

/**
 * Which reminders are due right now? PURE. ONE PER RUN (see buildShiftRuns):
 * only the run's FIRST shift carries it, timed by that shift's start, and the
 * ledger key is that first shift's (assignment, coach).
 *
 * Re-asserts `published` and the live status even though the reader already
 * filters on both: a coach must never learn about an unpublished shift, and
 * this function is the last thing between a row and a push.
 *
 * @param {Array<object>} shifts  fetchApiShiftRows() rows for WHOLE dates (a
 *   run is only right when every shift of its date is present)
 * @param {object} ctx
 * @param {number} ctx.nowMs
 * @param {Record<string,string>} [ctx.tzByLocation]  location_id -> IANA tz
 * @param {Set<string>} [ctx.onLeave]   leaveKey() values (whole-day leave)
 * @param {Set<string>} [ctx.sentKeys]  reminderKey() values already in the ledger
 * @returns {Array<{ shift: object, run: object[], runEndMs: number, kind: string,
 *   startMs: number, fireAtMs: number, leadMinutes: number }>}
 *   `shift` is the run's first shift; `run` is every shift of the run in order.
 */
export function dueShiftReminders(shifts, { nowMs, tzByLocation = {}, onLeave = new Set(), sentKeys = new Set() } = {}) {
  const due = []
  // Quiet hours at every location in play: nothing can be due, skip the work.
  const zones = new Set((shifts || []).map((sh) => tzByLocation[sh?.location_id] || DEFAULT_TZ))
  if (![...zones].some((tz) => isInSendWindow(nowMs, tz))) return due
  for (const run of buildShiftRuns(shifts, { tzByLocation, onLeave, sentKeys })) {
    if (run.reminded) continue
    const tz = tzByLocation[run.first.location_id] || DEFAULT_TZ
    const plan = reminderPlanFor(run.first, tz)
    if (!isReminderDue(plan, nowMs, tz)) continue
    due.push({ shift: run.first, run: run.shifts, runEndMs: run.endMs, ...plan })
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

// "Al, Bo and Cy" when all are shown, otherwise "Al, Bo +2 more".
function coNamesLabel(names, shown) {
  if (shown >= names.length) return joinNames(names)
  return `${names.slice(0, shown).join(', ')} +${names.length - shown} more`
}

// The wall-clock end of whichever shift of the run ends LATEST (a long shift
// can outlast the one that starts after it). Minutes are counted from the
// run's date, an end at or before its own start being the next day.
function latestEndLabel(run) {
  let best = null
  for (const s of run) {
    const start = effectiveShiftStart(s)
    const end = effectiveShiftEnd(s)
    if (!start || !end) continue
    let mins = minutesOfDay(end)
    if (mins < minutesOfDay(start)) mins += 24 * 60
    if (!best || mins > best.mins) best = { mins, label: hhmm(end) }
  }
  return best?.label || ''
}

/**
 * Title + body for ONE RUN of shifts (see buildShiftRuns), e.g.
 *   "3 shifts tomorrow from 05:45"
 *   "Tomorrow 05:45 to 10:30 at Studio North: Early Morning, Morning 8am, Morning 9:15 · with Bo and Sam"
 *
 * "today"/"tomorrow" is computed from the run's date against the Dublin day of
 * `nowMs`, not from the reminder kind: an evening-before reminder for an 08:30
 * shift that could not go until 07:00 on the day must say "today". Studios are named in the order they
 * are worked. `coNames` are the colleagues on the FIRST shift only.
 *
 * Kept lock-screen short, as a HARD cap (BODY_MAX_CHARS): colleagues start at
 * MAX_CO_NAMES; shift names give way to "+N more" from the end (never below
 * one), then colleagues (to none), then the body is cut with an ellipsis.
 */
export function buildShiftReminderMessage({ run, nameByLocation = {}, coNames = [], nowMs }) {
  const first = run[0]
  const start = hhmm(effectiveShiftStart(first))
  const end = latestEndLabel(run)
  const today = dublinDayStr(nowMs)
  const dayWord = first.shift_date === today
    ? 'today'
    : first.shift_date === addDaysISO(today, 1) ? 'tomorrow' : `on ${first.shift_date}`

  const studios = []
  for (const s of run) {
    const n = nameByLocation[s.location_id]
    if (n && !studios.includes(n)) studios.push(n)
  }
  const shiftNames = run.map((s) => s.shift_templates?.name).filter(Boolean)

  let head = `${dayWord[0].toUpperCase()}${dayWord.slice(1)} ${start}`
  if (end) head += ` to ${end}`
  if (studios.length) head += ` at ${joinNames(studios)}`
  const compose = (shownShifts, shownCo) => {
    const hidden = shiftNames.length - shownShifts
    const names = shiftNames.length ? `: ${shiftNames.slice(0, shownShifts).join(', ')}${hidden ? ` +${hidden} more` : ''}` : ''
    const tail = shownCo > 0 ? ` · with ${coNamesLabel(coNames, shownCo)}` : ''
    return head + names + tail
  }
  // BODY_MAX_CHARS is a HARD cap. What gives way, in order: shift names (down
  // to one), then colleagues (down to none), then an ellipsis. The day, times
  // and studio lead the body so they are the last thing an ellipsis can reach.
  let shownShifts = shiftNames.length
  let shownCo = Math.min(coNames.length, MAX_CO_NAMES)
  while (shownShifts > 1 && compose(shownShifts, shownCo).length > BODY_MAX_CHARS) shownShifts--
  while (shownCo > 0 && compose(shownShifts, shownCo).length > BODY_MAX_CHARS) shownCo--
  let body = compose(shownShifts, shownCo)
  if (body.length > BODY_MAX_CHARS) body = `${body.slice(0, BODY_MAX_CHARS - 1).trimEnd()}…`

  const title = run.length > 1 ? `${run.length} shifts ${dayWord} from ${start}` : `Shift ${dayWord} at ${start}`
  return { title, body }
}

function emptySummary() {
  return {
    quiet_hours: 0,
    shift_candidates: 0,
    shift_pushed: 0,
    shift_emailed: 0,
    shift_skipped_dup: 0,
    shift_skipped_no_recipient: 0,
    shift_send_failed: 0,
    shift_send_threw: 0,
    shift_claim_failed: 0,
    shift_read_capped: 0,
  }
}

// Narrow a push_reminder_sends delete/update to this shift's own ledger row.
const ownLedgerRow = (query, s) =>
  query.eq('entity_type', 'shift').eq('entity_id', s.id).eq('recipient_id', s.profile_id)

/**
 * The cron arm. Reads today's + tomorrow's PUBLISHED live shifts at every
 * location (whole dates, so every run is complete), decides which RUNS are
 * due, and sends each run's reminder once.
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
 *   - sender THROWS      -> outcome unknown: claim KEPT, logged at error level.
 *   - send fails         -> nothing delivered AND push or email failed: claim
 *                           released, next tick retries (inside the send window).
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

  // QUIET HOURS — before ANY database read. Outside [07:00, 22:00) nothing can
  // be due (dueShiftReminders enforces the same rule per run; this is the cheap
  // exit for the 9 hours a night when the answer is already known).
  if (!locations.some((l) => isInSendWindow(nowMs, l.timezone || DEFAULT_TZ))) {
    summary.quiet_hours = 1
    return summary
  }

  const today = dublinDayStr(nowMs)
  const tomorrow = addDaysISO(today, 1)
  const tzByLocation = Object.fromEntries(locations.map((l) => [l.id, l.timezone || DEFAULT_TZ]))
  const nameByLocation = Object.fromEntries(locations.map((l) => [l.id, l.name || '']))

  // Two days across the estate is tens of rows, far under the 1,000-row cap
  // (the reader is not paged; if that ever stops being true it is said, below).
  // publishedOnly is the D1 rule: coaches never see an unpublished shift.
  const { rows, error: shiftErr, capped } = await fetchApiShiftRows(db, {
    locationIds, startDate: today, endDate: tomorrow, publishedOnly: true,
  })
  if (shiftErr) throw new Error(`shift read failed: ${shiftErr.message || shiftErr}`)
  if (capped) {
    summary.shift_read_capped = 1
    logWarn('shift-reminders', 'shift read hit the 1,000-row cap — some shifts were NOT read, so runs may be incomplete and reminders missed; page fetchApiShiftRows', { startDate: today, endDate: tomorrow })
  }
  if (rows.length === 0) return summary

  // COST: most ticks end here. Leave can only REMOVE a coach's day, never make
  // a run due, so if nothing is time-due without it there is nothing to read.
  if (dueShiftReminders(rows, { nowMs, tzByLocation }).length === 0) return summary

  let onLeave = new Set()
  const profileIds = [...new Set(rows.map((r) => r.profile_id).filter(Boolean))]
  const { data: leaveRows, error: leaveErr } = await db
    .from('time_off_requests')
    .select('profile_id, start_date, end_date, status, total_days')
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
  // Read by COACH, not by the first shift's id: the claim that marks a run as
  // reminded may sit on ANY shift of it (an earlier shift was added since), or
  // on a shift the coach has since swapped away (buildShiftRuns' ghost). A run
  // on date D is reminded no earlier than 20:00 on D-1 and the rows cover today
  // and tomorrow, so the oldest claim that can matter is about 28 hours old.
  const { data: ledgerRows, error: ledgerErr } = await db
    .from('push_reminder_sends')
    .select('entity_id, recipient_id')
    .eq('entity_type', 'shift')
    .in('recipient_id', [...new Set(timeDue.map((d) => d.shift.profile_id))])
    .gte('sent_at', new Date(nowMs - LEDGER_LOOKBACK_HOURS * 60 * MINUTE_MS).toISOString())
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
      run: d.run,
      nameByLocation,
      coNames: coRosteredFirstNames(s, rows, onLeave), // the FIRST shift's colleagues only
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
          shift_count: d.run.length,
        },
      })
    } catch (err) {
      // notifyUsers is documented as never throwing. If it throws anyway we do
      // not know whether the push already left, and releasing the claim would
      // repeat it every 5 minutes. KEEP the claim: at worst this one reminder
      // is lost, and it is said at error level.
      summary.shift_send_threw++
      logError('shift-reminders', 'notify THREW — outcome unknown, claim KEPT, this reminder will not retry', { err: err?.message, assignment: s.id })
      continue
    }

    // Release ONLY when nothing at all was delivered AND something failed, on
    // either channel. email_failed counts: for a coach with no device (Android
    // today) the email fallback is the only channel, and a mail blip with
    // failed = 0 used to keep the claim and lose the reminder. Any delivery, on
    // any channel, keeps the claim: a partial success must never repeat.
    const delivered = (result?.sent || 0) > 0 || (result?.emailed || 0) > 0
    const somethingFailed = (result?.failed || 0) > 0 || (result?.email_failed || 0) > 0
    if (!delivered && somethingFailed) {
      summary.shift_send_failed++
      const { error: releaseErr } = await ownLedgerRow(db.from('push_reminder_sends').delete(), s)
      if (releaseErr) logError('shift-reminders', 'claim release failed — this reminder will NOT retry', { err: releaseErr, assignment: s.id })
      continue
    }

    // Diagnostics only (mig 169: push_count / push_invalidated).
    const { error: countErr } = await ownLedgerRow(db.from('push_reminder_sends').update({
      push_count: result?.sent || 0,
      push_invalidated: result?.invalidated || 0,
    }), s)
    if (countErr) logWarn('shift-reminders', 'ledger count update failed', { err: countErr, assignment: s.id })

    if ((result?.sent || 0) > 0) summary.shift_pushed++
    else if ((result?.emailed || 0) > 0) summary.shift_emailed++
    else summary.shift_skipped_no_recipient++
  }

  return summary
}
