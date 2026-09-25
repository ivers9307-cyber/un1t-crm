// shared/availability.js
//
// AVAIL.1 — coach availability rules. PURE: no imports, no IO, no clock, no
// host timezone. Shared by the web calendar and picker, the API
// (src/lib/availability-server.js, src/lib/availability-notify.js), and the
// phone (AVAIL.2, CANDIDATES.1) as `shared/availability`.
//
// A coach declares when they CANNOT work; everything else is available.
//   weekly  { kind:'weekly', weekday:'mon'..'sun', all_day, start_time, end_time, note }
//   dated   { kind:'dated', start_date, end_date, all_day, start_time, end_time, note }
// Weekday codes are shift_templates.days_of_week's (mig 067) and
// src/lib/roster.js WEEKDAY_CODES: Monday first.
// Times are 'HH:MM' (Postgres's 'HH:MM:SS' is read too). There are NO
// overnight windows: end must be after start on the same day, and a shift
// that crosses midnight is judged against the whole day.
// The database (mig 630) enforces the same shape with CHECKs; these functions
// give the SAME answers earlier, in words a coach can act on.

export const AVAILABILITY_WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
export const AVAILABILITY_WEEKDAY_LABELS = Object.freeze({
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
})
const WEEKDAY_PLURAL = Object.freeze({
  mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays', thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays', sun: 'Sundays',
})
// spanDays mirrors mig 630's `end_date - start_date <= 365`; noteChars its note CHECK.
export const AVAILABILITY_LIMITS = Object.freeze({ weekly: 28, dated: 60, noteChars: 200, spanDays: 366, aheadDays: 730 })

const DAY_MS = 86400000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/

/** Whole days since 1970-01-01 for a REAL calendar date, else null. */
function dayIndex(iso) {
  const m = ISO_DAY.exec(typeof iso === 'string' ? iso : '')
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  // Date.UTC rolls 30 Feb into March; a round trip that changes the digits
  // was never a real date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms / DAY_MS
}

/** 'mon'..'sun' for a real 'YYYY-MM-DD', else null. */
export function weekdayOf(iso) {
  const n = dayIndex(iso)
  if (n === null) return null
  return AVAILABILITY_WEEKDAYS[(new Date(n * DAY_MS).getUTCDay() + 6) % 7]
}

function minutes(t) {
  const m = TIME.exec(typeof t === 'string' ? t : '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
function hhmm(t) {
  const m = TIME.exec(typeof t === 'string' ? t : '')
  return m ? `${m[1]}:${m[2]}` : null
}
function time12(t) {
  const total = minutes(t)
  if (total === null) return ''
  const h = Math.floor(total / 60)
  const mm = total % 60
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return mm === 0 ? `${h12}${suffix}` : `${h12}:${String(mm).padStart(2, '0')}${suffix}`
}
// '2026-10-03' → '3 Oct'. String digits only: no Date, so no timezone moves a day.
const dayMonth = (iso) => `${Number(String(iso).slice(8, 10))} ${MONTHS[Number(String(iso).slice(5, 7)) - 1] || ''}`.trim()

/** One rule in canonical form (accepts API input, DB rows and RPC snapshots). */
export function normaliseRule(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = raw.kind === 'weekly' || raw.kind === 'dated' ? raw.kind : (raw.weekday ? 'weekly' : 'dated')
  const allDay = raw.all_day === true
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null
  return {
    kind,
    weekday: kind === 'weekly' && typeof raw.weekday === 'string' ? raw.weekday.trim().toLowerCase() : null,
    start_date: kind === 'dated' ? (raw.start_date ?? null) : null,
    end_date: kind === 'dated' ? (raw.end_date || raw.start_date || null) : null,
    all_day: allDay,
    start_time: allDay ? null : hhmm(raw.start_time),
    end_time: allDay ? null : hhmm(raw.end_time),
    note,
  }
}

// Identity of a rule's CONTENT (no note): what diffAvailability compares.
function windowKey(r) {
  return [r.kind, r.weekday ?? '', r.start_date ?? '', r.end_date ?? '', r.all_day ? 'all' : `${r.start_time}-${r.end_time}`].join('|')
}
const fullKey = (r) => `${windowKey(r)}|${r.note ?? ''}`

function compareRules(a, b) {
  if (a.kind !== b.kind) return a.kind === 'weekly' ? -1 : 1
  const byDay = a.kind === 'weekly'
    ? AVAILABILITY_WEEKDAYS.indexOf(a.weekday) - AVAILABILITY_WEEKDAYS.indexOf(b.weekday)
    : String(a.start_date).localeCompare(String(b.start_date)) || String(a.end_date).localeCompare(String(b.end_date))
  if (byDay) return byDay
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1
  return String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')) || fullKey(a).localeCompare(fullKey(b))
}

function flat(input) {
  if (Array.isArray(input)) return input
  return [...(input?.weekly || []), ...(input?.dated || [])]
}

/** { weekly, dated } in canonical form: sorted, exact duplicates dropped. */
export function normaliseAvailability(input) {
  const out = { weekly: [], dated: [] }
  const seen = new Set()
  for (const [list, kind] of [[input?.weekly, 'weekly'], [input?.dated, 'dated']]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const rule = normaliseRule({ ...(raw && typeof raw === 'object' ? raw : {}), kind })
      const key = fullKey(rule)
      if (seen.has(key)) continue
      seen.add(key)
      out[kind].push(rule)
    }
  }
  out.weekly.sort(compareRules)
  out.dated.sort(compareRules)
  return out
}

/** Flat rows (a DB read, an RPC snapshot) → { weekly, dated }. */
export function splitRules(rows) {
  const list = (rows || []).map(normaliseRule).filter(Boolean)
  return normaliseAvailability({
    weekly: list.filter((r) => r.kind === 'weekly'),
    dated: list.filter((r) => r.kind === 'dated'),
  })
}

/**
 * A rule's CONTENT identity (kind, day or dates, window; not the note), for
 * matching what a client sends back against what is stored.
 */
export function ruleKey(rule) {
  const r = normaliseRule(rule)
  return r ? windowKey(r) : ''
}

/**
 * What is wrong with one canonical rule, in the coach's words; null if nothing.
 * `knownKeys` (optional): ruleKey()s of the person's STORED dated rules that
 * started before today. A dated rule that ended before today is refused
 * ('That date has passed') unless it is one of them: then it is history the
 * client merely sent back (a tab left open over midnight), which is no
 * problem, and the caller drops it with withoutEnded() before saving.
 */
export function ruleProblem(rule, { todayIso = null, knownKeys = null } = {}) {
  if (!rule) return 'This entry could not be read'
  if (rule.kind === 'weekly') {
    if (!AVAILABILITY_WEEKDAYS.includes(rule.weekday)) return 'Choose a day of the week'
  } else {
    const start = dayIndex(rule.start_date)
    const end = dayIndex(rule.end_date)
    if (start === null || end === null) return 'Use a real date'
    if (end < start) return 'The last day is before the first day'
    if (end - start + 1 > AVAILABILITY_LIMITS.spanDays) return 'Up to a year at a time'
    const today = dayIndex(todayIso)
    if (today !== null && end < today) return knownKeys?.has(windowKey(rule)) ? null : 'That date has passed'
    if (today !== null && start > today + AVAILABILITY_LIMITS.aheadDays) return 'Up to two years ahead'
  }
  if (!rule.all_day) {
    const s = minutes(rule.start_time)
    const e = minutes(rule.end_time)
    if (s === null || e === null) return 'Give a start and an end time, or choose all day'
    if (e <= s) return 'The end time must be after the start time'
  }
  if (rule.note && rule.note.length > AVAILABILITY_LIMITS.noteChars) return `Keep the note to ${AVAILABILITY_LIMITS.noteChars} characters`
  return null
}

/** { weekly, dated } without the dated rules that ended before todayIso (history is never re-saved). */
export function withoutEnded(input, todayIso) {
  const today = dayIndex(todayIso)
  return {
    weekly: input.weekly,
    dated: input.dated.filter((r) => {
      const end = dayIndex(r.end_date)
      return today === null || end === null || end >= today
    }),
  }
}

/** Every problem with a canonical { weekly, dated }: [{ path, message }] (validateBody's issue shape). */
export function availabilityProblems(input, opts = {}) {
  const issues = []
  if (input.weekly.length > AVAILABILITY_LIMITS.weekly) issues.push({ path: 'weekly', message: `Up to ${AVAILABILITY_LIMITS.weekly} weekly entries` })
  if (input.dated.length > AVAILABILITY_LIMITS.dated) issues.push({ path: 'dated', message: `Up to ${AVAILABILITY_LIMITS.dated} dates` })
  for (const kind of ['weekly', 'dated']) {
    input[kind].forEach((rule, i) => {
      const message = ruleProblem(rule, opts)
      if (message) issues.push({ path: `${kind}.${i}`, message })
    })
  }
  return issues
}

/** The rules that apply on one date. */
export function rulesOnDate(rules, dateIso) {
  const day = dayIndex(dateIso)
  if (day === null) return []
  const wd = weekdayOf(dateIso)
  return (rules || []).map(normaliseRule).filter((r) => {
    if (!r) return false
    if (r.kind === 'weekly') return r.weekday === wd
    const s = dayIndex(r.start_date)
    const e = dayIndex(r.end_date)
    return s !== null && e !== null && s <= day && day <= e
  })
}

/**
 * Is this person unavailable for [startTime, endTime) on dateIso? null when
 * not, else the matching rules (sorted). Overlap is strict: a shift ending
 * as a window starts is fine. No times, or an end not after the start (a
 * shift crossing midnight), asks about the whole day. ADVISORY everywhere it
 * is used: it never blocks an assignment.
 */
export function unavailableFor(rules, dateIso, startTime = null, endTime = null) {
  const s = minutes(startTime)
  const e = minutes(endTime)
  const wholeDay = s === null || e === null || e <= s
  const hits = rulesOnDate(rules, dateIso).filter((r) => {
    if (r.all_day || wholeDay) return true
    const rs = minutes(r.start_time)
    const re = minutes(r.end_time)
    if (rs === null || re === null) return true // unreadable window: flag it, the advisory side
    return s < re && rs < e
  })
  return hits.length ? hits.sort(compareRules) : null
}

/** '9am–12pm' or 'all day'. */
export function describeWindow(rule) {
  const r = normaliseRule(rule)
  if (!r || r.all_day) return 'all day'
  return `${time12(r.start_time)}–${time12(r.end_time)}`
}

/** 'Mondays, 9am–12pm' · '3 Oct, all day' · '3 Oct – 5 Oct, 5pm–7:30pm'. */
export function describeRule(rule) {
  const r = normaliseRule(rule)
  if (!r) return ''
  const when = r.kind === 'weekly'
    ? (WEEKDAY_PLURAL[r.weekday] || r.weekday)
    : (r.start_date === r.end_date ? dayMonth(r.start_date) : `${dayMonth(r.start_date)} – ${dayMonth(r.end_date)}`)
  return `${when}, ${describeWindow(r)}`
}

/** The picker badge text for unavailableFor's matches. */
export function unavailableSummary(matches) {
  if (!matches || matches.length === 0) return ''
  if (matches.some((r) => normaliseRule(r)?.all_day)) return 'all day'
  return [...new Set(matches.map(describeWindow))].join(', ')
}

/** What a save added and removed, by content (a note-only edit is neither). */
export function diffAvailability(before, after) {
  const b = flat(splitRules(flat(before)))
  const a = flat(splitRules(flat(after)))
  const bKeys = new Set(b.map(windowKey))
  const aKeys = new Set(a.map(windowKey))
  return {
    added: a.filter((r) => !bKeys.has(windowKey(r))),
    removed: b.filter((r) => !aKeys.has(windowKey(r))),
  }
}

/** Same rules AND same notes. */
export function sameAvailability(x, y) {
  const a = flat(splitRules(flat(x))).map(fullKey)
  const b = flat(splitRules(flat(y))).map(fullKey)
  return a.length === b.length && a.every((k, i) => k === b[i])
}
