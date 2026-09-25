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
  AVAILABILITY_LIMITS, AVAILABILITY_WEEKDAYS, AVAILABILITY_WEEKDAY_LABELS, normaliseRule, normaliseAvailability,
  ruleProblem, carryStartedRules, withoutEnded, sameAvailability, describeRule,
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
  chooseDay: 'Choose a day in the calendar',
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
  weekday: 'mon', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '', storedStart: null,
})

/**
 * A stored rule (the GET's or the PUT's shape) → an editable row. A dated
 * row remembers its stored start (`storedStart`): once that is before today
 * (judged at render time, isStarted) the card locks the start and the window,
 * the way the web editor does, and the save sends that start back for the
 * server to carry on from today.
 */
export function rowFromRule(rule, key) {
  const r = normaliseRule(rule)
  if (!r) return null
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
    storedStart: r.kind === 'dated' ? (r.start_date || null) : null,
  }
}

/** The server's { weekly, dated } → rows, weekly first, in the server's order. Anything unreadable is skipped. */
export function rowsFromServer(data, nextKey) {
  const tagged = [
    ...(Array.isArray(data?.weekly) ? data.weekly : []).map((r) => [r, 'weekly']),
    ...(Array.isArray(data?.dated) ? data.dated : []).map((r) => [r, 'dated']),
  ]
  return tagged
    .filter(([r]) => r && typeof r === 'object')
    .map(([r, kind]) => rowFromRule({ ...r, kind }, nextKey()))
}

/**
 * A new card, all day: a weekly one on Monday; a dated one with NO dates
 * until the coach taps one. (Opened on today, the calendar held a start and
 * no end, so the first tap EXTENDED from today: 3 Oct became 25 Sep – 3 Oct.)
 */
export function newRow(kind, { nextKey }) {
  return kind === 'weekly'
    ? { key: nextKey(), kind: 'weekly', ...BLANK }
    : { key: nextKey(), kind: 'dated', ...BLANK }
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
export function calendarRange(row, { todayIso = null } = {}) {
  const start = row?.start_date || null
  const end = row?.end_date && row.end_date !== start ? row.end_date : null
  return { startDate: start, endDate: end, initialMonth: isStarted(row, todayIso) ? (end || start) : null }
}

/**
 * MonthCalendar's onChange → the card's dates (a first tap is a one-day
 * entry). On a started card the calendar holds both ends, so every tap
 * arrives as a fresh start: it becomes the new LAST day, and the stored start
 * stays (AVAIL.1a carries the rule on from today).
 */
export function rangeFromCalendar({ start, end } = {}, row = null, { todayIso = null } = {}) {
  if (isStarted(row, todayIso)) return { start_date: row.storedStart, end_date: end || start || row.end_date || row.storedStart }
  return { start_date: start || '', end_date: end || start || '' }
}

/**
 * A STORED dated rule that has started (its stored start, unchanged, is
 * before today) and not ended. Judged at render time from today, so a screen
 * left open past midnight locks a rule that started "today" when it loaded.
 * A card the coach added is never started: it has no stored start.
 */
export function isStarted(row, todayIso) {
  if (row?.kind !== 'dated' || !todayIso || !row.storedStart) return false
  if (row.start_date !== row.storedStart || row.storedStart >= todayIso) return false
  return !hasEnded(row, todayIso)
}

/** A dated row whose last day is before today: history. Shown, never edited, never sent. */
export function hasEnded(row, todayIso) {
  if (row?.kind !== 'dated') return false
  return withoutEnded({ weekly: [], dated: [rowToRule(row)] }, todayIso).dated.length === 0
}

/**
 * The LOADED dated rules that started before today, canonical: the phone's
 * copy of what the route reads as `stored` for carryStartedRules (the
 * person's stored dated rules starting before today). Judged with the today
 * of the moment asked, so a screen left open over midnight agrees with the
 * server at save time.
 */
export function startedRules(baselineRows, todayIso) {
  return (baselineRows || [])
    .filter((r) => r?.kind === 'dated' && r.start_date && todayIso && r.start_date < todayIso)
    .map(rowToRule)
}

/**
 * What is wrong with one card, in the coach's words; null if nothing.
 * `started` (startedRules of the load) switches on the server's started-rule
 * contract: a started rule the coach already has, or with only its note or
 * last day changed, is fine; anything else starting before today is 'Start
 * today or later'. Without it (nothing loaded) backdating is left to the route.
 */
export function rowProblem(row, { todayIso = null, started = null } = {}) {
  if (!row?.all_day) {
    for (const typed of [row?.start_time, row?.end_time]) {
      if (String(typed ?? '').trim() && parseTimeInput(typed) === null) return AVAILABILITY_COPY.timeFormat
    }
  }
  if (row?.kind === 'dated' && !row.start_date) return AVAILABILITY_COPY.chooseDay
  const rule = rowToRule(row)
  if (rule?.kind !== 'dated' || !started) return ruleProblem(rule, { todayIso })
  const carried = carryStartedRules({ weekly: [], dated: [rule] }, started, todayIso)
  return ruleProblem(carried.input.dated[0], { todayIso, knownKeys: carried.knownKeys })
}

const liveRows = (rows, todayIso) => (rows || []).filter((r) => !hasEnded(r, todayIso))

/** Everything that stops a save: { byKey, banner, ok }. Ended cards are never judged (they are not sent). */
export function formProblems(rows, { todayIso = null, started = null } = {}) {
  const live = liveRows(rows, todayIso)
  const byKey = {}
  for (const row of live) {
    const problem = rowProblem(row, { todayIso, started })
    if (problem) byKey[row.key] = problem
  }
  const banner = []
  if (live.filter((r) => r.kind === 'weekly').length > AVAILABILITY_LIMITS.weekly) banner.push(AVAILABILITY_COPY.weeklyFull)
  if (live.filter((r) => r.kind === 'dated').length > AVAILABILITY_LIMITS.dated) banner.push(AVAILABILITY_COPY.datedFull)
  return { byKey, banner: banner.length ? banner.join(' ') : null, ok: Object.keys(byKey).length === 0 && banner.length === 0 }
}

/** May the coach add another card of this kind? (The route caps each list.) */
export function canAdd(rows, kind, { todayIso = null } = {}) {
  return liveRows(rows, todayIso).filter((r) => r.kind === kind).length < AVAILABILITY_LIMITS[kind]
}

// normaliseRule's output has a fixed key order, so its JSON is its identity:
// equal JSON = same kind, day or dates, window AND note, which is exactly
// what normaliseAvailability treats as a duplicate.
const identity = (rule) => JSON.stringify(rule)

/** Cards that repeat an earlier card exactly: only one of them is saved. */
export function duplicateKeys(rows, { todayIso = null } = {}) {
  const seen = new Set()
  const dup = new Set()
  for (const row of liveRows(rows, todayIso)) {
    if (rowProblem(row, { todayIso })) continue
    const id = identity(rowToRule(row))
    if (seen.has(id)) dup.add(row.key)
    else seen.add(id)
  }
  return dup
}

// '2026-09-20' → '20 Sep'. String digits only: no Date, so no timezone moves a day.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayMonth = (iso) => `${Number(String(iso).slice(8, 10))} ${MONTHS[Number(String(iso).slice(5, 7)) - 1] || ''}`.trim()

/** The line under a started dated card that has not ended (the web editor's words); else null. */
export function startedNote(row, { todayIso = null } = {}) {
  if (!isStarted(row, todayIso)) return null
  return `Started ${dayMonth(row.storedStart)}. The days already gone stay as they are: you can change the last day or the note, or remove it from today.`
}

/** A card's one-line name, 'Mondays, all day'; an unfinished card says so. */
export function rowSummary(row, { todayIso = null } = {}) {
  if (!hasEnded(row, todayIso) && rowProblem(row, { todayIso })) {
    return row?.kind === 'dated' ? 'Unfinished date' : 'Unfinished weekly time'
  }
  return describeRule(rowToRule(row))
}

// The route's body schema (AvailabilityPutSchema): no `kind`, the list says it.
function toPayload(rule) {
  const span = { all_day: rule.all_day, start_time: rule.start_time, end_time: rule.end_time, note: rule.note }
  return rule.kind === 'weekly'
    ? { weekday: rule.weekday, ...span }
    : { start_date: rule.start_date, end_date: rule.end_date, ...span }
}

/**
 * The PUT body for these cards: ended dated cards left out, exact copies
 * sent once, both lists in the server's canonical order. A started card goes
 * with its stored start (the server carries it on from today).
 *   body       { weekly, dated } for PUT /api/schedule/availability
 *   canonical  the same as canonical rules (what isDirty compares)
 *   keysByPath 'weekly.0' → the card keys that became that entry (the
 *              server's issue paths index these sorted lists; its carry
 *              keeps their order and length)
 *   endedKeys  the cards left out because they ended
 */
export function buildSaveBody(rows, { todayIso = null } = {}) {
  const endedKeys = []
  const keysById = new Map()
  const lists = { weekly: [], dated: [] }
  for (const row of rows || []) {
    if (hasEnded(row, todayIso)) {
      endedKeys.push(row.key)
      continue
    }
    const rule = rowToRule(row)
    const id = identity(rule)
    if (!keysById.has(id)) {
      keysById.set(id, [])
      lists[rule.kind].push(rule)
    }
    keysById.get(id).push(row.key)
  }
  const canonical = normaliseAvailability(lists)
  const keysByPath = {}
  for (const kind of ['weekly', 'dated']) {
    canonical[kind].forEach((rule, i) => { keysByPath[`${kind}.${i}`] = keysById.get(identity(rule)) || [] })
  }
  return {
    body: { weekly: canonical.weekly.map(toPayload), dated: canonical.dated.map(toPayload) },
    canonical,
    keysByPath,
    endedKeys,
  }
}

/**
 * Would saving change anything? Compares what WOULD BE SENT: the same rules
 * and notes in any order, typed any way, are no change. Nothing loaded
 * (baselineRows null) is never dirty, so it can never be saved over.
 */
export function isDirty(baselineRows, rows, { todayIso = null } = {}) {
  if (!baselineRows) return false
  return !sameAvailability(buildSaveBody(baselineRows, { todayIso }).canonical, buildSaveBody(rows, { todayIso }).canonical)
}

// 'a new date cannot start before today' → 'A new date cannot start before today.'
function sentence(text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const s = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

// 'dated.3' (the shared rules) or 'weekly.0.note' (the route's shape check).
const ISSUE_PATH = /^(weekly|dated)\.(\d+)(?:\.|$)/

/**
 * The GET's answer → { ok: true, data } or { ok: false, message, canRetry }.
 * Anything but a readable { weekly, dated } is a failed load, and a failed
 * load can never be saved over (saveButtonState needs `loaded`).
 */
export function loadOutcome(res) {
  const d = res?.data
  if (res?.success && d && Array.isArray(d.weekly) && Array.isArray(d.dated)) {
    return { ok: true, data: { weekly: d.weekly, dated: d.dated } }
  }
  if (res?.status === 401) return { ok: false, message: AVAILABILITY_COPY.loadSignedOut, canRetry: false }
  const hint = res?.transport ? 'Check your connection and try again.' : 'Try again in a moment.'
  return { ok: false, message: `${AVAILABILITY_COPY.loadFailed} ${hint}`, canRetry: true }
}

/**
 * The PUT's answer → what the screen does and says.
 *   tone       'ok' (green) | 'warn' (amber: it may or may not have saved) | 'error' (red)
 *   saved      the server's { weekly, dated } after the save (the form becomes
 *              it), or null (on 'ok': read the rules back)
 *   rowErrors  { [cardKey]: message } from the server's issues
 * Every failure keeps the coach's edits: the screen replaces them only on 'ok'.
 */
export function saveOutcome(res, { keysByPath = {} } = {}) {
  if (res?.success) {
    const d = res.data
    const readable = !!d && Array.isArray(d.weekly) && Array.isArray(d.dated)
    return {
      tone: 'ok',
      message: d?.changed === false ? AVAILABILITY_COPY.unchanged : AVAILABILITY_COPY.saved,
      saved: readable ? { weekly: d.weekly, dated: d.dated } : null,
      rowErrors: {},
    }
  }
  // transport: api() minted it with no server answer: no connection, OR a
  // non-JSON edge page after the request may already have landed. The PUT
  // replaces, so it is idempotent: "saving again is safe" holds either way.
  if (res?.transport) return { tone: 'warn', message: AVAILABILITY_COPY.noAnswer, saved: null, rowErrors: {} }
  if (res?.status === 401) return { tone: 'error', message: AVAILABILITY_COPY.sessionEnded, saved: null, rowErrors: {} }

  const rowErrors = {}
  const loose = []
  for (const issue of Array.isArray(res?.issues) ? res.issues : []) {
    const m = String(issue?.path ?? '').match(ISSUE_PATH)
    const keys = m ? keysByPath[`${m[1]}.${m[2]}`] : null
    if (keys && keys.length) {
      for (const k of keys) {
        if (!rowErrors[k]) rowErrors[k] = String(issue.message || 'Check this entry')
      }
    } else if (issue?.message) {
      loose.push(sentence(issue.message))
    }
  }
  if (Object.keys(rowErrors).length) {
    return { tone: 'error', message: [AVAILABILITY_COPY.invalid, ...loose].join(' '), saved: null, rowErrors }
  }
  const reason = loose.length ? loose.join(' ') : sentence(res?.error || 'Something went wrong')
  return { tone: 'error', message: `${AVAILABILITY_COPY.failed} ${reason} ${AVAILABILITY_COPY.keptHere}`, saved: null, rowErrors }
}

/** Leaving the screen: mid-save stays, unsaved edits ask first, otherwise go (mail-compose's rule). */
export function closeAction({ saving = false, dirty = false } = {}) {
  if (saving) return 'block'
  return dirty ? 'confirm' : 'close'
}

/** The header Save: only after a successful load, only with something to save, never twice. */
export function saveButtonState({ loaded = false, saving = false, dirty = false } = {}) {
  return { disabled: !loaded || saving || !dirty, busy: saving }
}

/**
 * May the coach edit the cards? Not before a load, and not while a save is in
 * flight: a successful save REPLACES the cards with what the server stored,
 * so an edit typed mid-save would vanish without a word.
 */
export function cardsEditable({ loaded = false, saving = false } = {}) {
  return loaded && !saving
}

/** A master under "View as user" is editing someone else's availability: say whose. */
export function impersonationLine(impersonatingFrom, profile) {
  if (!impersonatingFrom) return null
  const name = profile?.full_name || 'this person'
  return `You are viewing as ${name}. Saving changes their availability, and their managers are told.`
}
