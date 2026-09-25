// mobile/lib/availability-form.js
//
// AVAIL.2 — every decision the phone's "My availability" screen
// (app/(staff)/schedule/availability.jsx) makes. There is no React Native
// component test runner, so the screen renders what these return and decides
// nothing itself.
//
// The RULES are shared/availability.js's, the same functions PUT
// /api/schedule/availability runs (AVAIL.1a), so the phone refuses in the
// server's words, only sooner. This file adds what only a form needs: typed
// text → a rule, the PUT body, the dirty check, and the server's answer →
// what the screen says.
//
// The PUT REPLACES the coach's weekly rules and their dated rules that have
// not ended (mig 630). Three consequences live here:
//   • Only a SUCCESSFUL load may be saved over (saveButtonState needs
//     `loaded`; isDirty(null) is false): saving a form whose load failed
//     would send an empty set and wipe every rule the coach has.
//   • A dated rule that ended while the screen was open (left open over
//     midnight) is left out of the body. The server keeps ended rules as
//     history and drops an unchanged one itself; leaving it out means the
//     phone never depends on that.
//   • The body is sent in CANONICAL order (normaliseAvailability: sorted,
//     exact duplicates dropped), because the server's issue paths ('dated.3')
//     index the sorted lists. keysByPath maps each path back to its rows.
//
// A dated rule that has already STARTED (its stored start is before today)
// follows AVAIL.1a's contract (shared/availability.js carryStartedRules),
// exactly as the web editor does: it is sent back with its STORED start, only
// its last day and its note can change (or it is removed), and the server
// keeps the days already gone as history and carries it on from today.

import {
  AVAILABILITY_LIMITS, AVAILABILITY_WEEKDAYS, AVAILABILITY_WEEKDAY_LABELS, normaliseRule,
} from 'shared/availability'
import { leaveDateRangeLabel } from 'shared/time-off'

export const AVAILABILITY_TITLE = 'My availability'
export const AVAILABILITY_INTRO =
  'Tell your managers when you can’t work. Every other time counts as available. There is nothing to approve: ' +
  'your managers at each of your studios get a notification when you save. Your managers can see your notes.'
export const AVAILABILITY_NO_OVERNIGHT = 'A time window stays within one day: it can’t run past midnight.'

// The Schedule tab's row (components/schedule/MyAvailabilityRow.jsx).
export const AVAILABILITY_ROW = Object.freeze({
  title: 'My availability',
  subtitle: 'Tell your managers when you can’t work',
})

export const AVAILABILITY_COPY = Object.freeze({
  loading: 'Loading your availability…',
  loadFailed: 'Couldn’t load your availability.',
  loadSignedOut: 'Your sign-in has expired. Sign in again to see your availability.',
  retry: 'Try again',
  weeklyHeading: 'Every week',
  datedHeading: 'Dates',
  weeklyEmpty: 'No weekly times. Add one for a day you can never work, or part of one.',
  datedEmpty: 'No dates. Add one for a day or a run of days you can’t work.',
  addWeekly: 'Add a weekly time',
  addDated: 'Add a date',
  weeklyFull: `Up to ${AVAILABILITY_LIMITS.weekly} weekly times.`,
  datedFull: `Up to ${AVAILABILITY_LIMITS.dated} dates.`,
  chooseDates: 'Choose dates',
  calendarHint: 'Tap a day, then tap another to make it a range.',
  calendarHintStarted: 'Tap the new last day.',
  timeFormat: 'Use a time like 09:30, 17:30 or 5:30pm',
  ended: 'This date has passed. It is kept as history and left out when you save.',
  duplicate: 'Same as another entry. Only one is kept.',
  saved: 'Saved. Your managers will get a notification.',
  unchanged: 'Saved. Nothing had changed, so nobody was notified.',
  nothingToSave: 'No changes to save.',
  invalid: 'Not saved. Fix the entries marked below.',
  noAnswer: 'Couldn’t confirm it saved: no connection, or no answer from the server. Your changes are still here, and saving again is safe.',
  sessionEnded: 'Not saved: your sign-in has expired. Sign in again, then make these changes again.',
  failed: 'Not saved.',
  keptHere: 'Your changes are still here.',
  discardTitle: 'Discard your changes?',
  discardBody: 'Your availability has not been saved.',
  discardKeep: 'Keep editing',
  discardConfirm: 'Discard',
})

// The weekday picker: shared codes, Monday first (shift_templates.days_of_week).
export const WEEKDAY_CHIPS = Object.freeze(AVAILABILITY_WEEKDAYS.map((code) => Object.freeze({
  code,
  label: AVAILABILITY_WEEKDAY_LABELS[code],
  short: AVAILABILITY_WEEKDAY_LABELS[code].slice(0, 3),
})))

/**
 * Row keys. The own GET carries no ids, and an index key would move a
 * half-typed note onto the wrong card when one above it is removed.
 */
export function createRowKeys(prefix = 'r') {
  let n = 0
  return () => `${prefix}${++n}`
}

const TIME_TEXT = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/

/**
 * What a coach types into a time field → 'HH:MM', or null. Reads 9 · 09 ·
 * 930 · 0930 · 9:30 · 9.30 · 17:30 · 1730 · 5pm · 5:30pm · 12am. Never 24:00:
 * a window stays inside one day (shared/availability.js).
 */
export function parseTimeInput(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '')
  const m = s.match(TIME_TEXT)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (min > 59) return null
  if (m[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Leaving a time field: tidy what reads ('930' → '09:30'); leave the rest for the coach to see. */
export function timeOnBlur(text) {
  return parseTimeInput(text) ?? String(text ?? '')
}

const BLANK = Object.freeze({
  weekday: 'mon', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '', startedOn: null,
})

/**
 * A stored rule (the GET's or the PUT's shape) → an editable row. With
 * `todayIso`, a dated rule that started before today keeps its stored start
 * as `startedOn`: the card then locks the start and the window, the way the
 * web editor does, and the save sends that start back for the server to carry.
 */
export function rowFromRule(rule, key, { todayIso = null } = {}) {
  const r = normaliseRule(rule)
  if (!r) return null
  const started = r.kind === 'dated' && !!todayIso && !!r.start_date && r.start_date < todayIso
  return {
    key,
    kind: r.kind,
    weekday: r.weekday || 'mon',
    start_date: r.start_date || '',
    end_date: r.end_date || '',
    all_day: r.all_day,
    start_time: r.start_time || '',
    end_time: r.end_time || '',
    note: r.note || '',
    startedOn: started ? r.start_date : null,
  }
}

/** The server's { weekly, dated } → rows, weekly first, in the server's order. Anything unreadable is skipped. */
export function rowsFromServer(data, nextKey, { todayIso = null } = {}) {
  const tagged = [
    ...(Array.isArray(data?.weekly) ? data.weekly : []).map((r) => [r, 'weekly']),
    ...(Array.isArray(data?.dated) ? data.dated : []).map((r) => [r, 'dated']),
  ]
  return tagged
    .filter(([r]) => r && typeof r === 'object')
    .map(([r, kind]) => rowFromRule({ ...r, kind }, nextKey(), { todayIso }))
}

/** A new card: all day; a weekly one on Monday, a dated one today. */
export function newRow(kind, { todayIso, nextKey }) {
  return kind === 'weekly'
    ? { key: nextKey(), kind: 'weekly', ...BLANK }
    : { key: nextKey(), kind: 'dated', ...BLANK, start_date: todayIso, end_date: todayIso }
}

/** A row as the canonical rule the server will read (typed times parsed; a one-day date ends where it starts). */
export function rowToRule(row) {
  const dated = row?.kind === 'dated'
  return normaliseRule({
    kind: dated ? 'dated' : 'weekly',
    weekday: dated ? null : row?.weekday,
    start_date: dated ? (row.start_date || null) : null,
    end_date: dated ? (row.end_date || row.start_date || null) : null,
    all_day: row?.all_day === true,
    start_time: parseTimeInput(row?.start_time),
    end_time: parseTimeInput(row?.end_time),
    note: row?.note,
  })
}

/** 'Sat 3 Oct – Mon 5 Oct' (shared/time-off's leave label, so the two forms read alike). */
export function datesLabel(row) {
  if (!row?.start_date) return AVAILABILITY_COPY.chooseDates
  return leaveDateRangeLabel(row.start_date, row.end_date || row.start_date)
}

/**
 * MonthCalendar's props for a card. A one-day entry passes NO end: the
 * calendar starts afresh on any tap while it holds both ends
 * (components/MonthCalendar.jsx tap()), so a stored one-day end would stop
 * the second tap from ever making a range. A started entry opens on the month
 * of its last day: its first days are in the past and cannot be picked.
 */
export function calendarRange(row) {
  const start = row?.start_date || null
  const end = row?.end_date && row.end_date !== start ? row.end_date : null
  return { startDate: start, endDate: end, initialMonth: row?.startedOn ? (end || start) : null }
}

/**
 * MonthCalendar's onChange → the card's dates (a first tap is a one-day
 * entry). On a started card the calendar holds both ends, so every tap
 * arrives as a fresh start: it becomes the new LAST day, and the stored start
 * stays (AVAIL.1a carries the rule on from today).
 */
export function rangeFromCalendar({ start, end } = {}, row = null) {
  if (row?.startedOn) return { start_date: row.startedOn, end_date: end || start || row.end_date || row.startedOn }
  return { start_date: start || '', end_date: end || start || '' }
}
