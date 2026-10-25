// BOOKINGWINDOWS.1 — a booking type's (event_types.availability) bookable
// windows for one weekday. The ONE reader of that JSON's day values.
//
// Shape: { mon: <day>, tue: <day>, ... sun: <day> } where <day> is
//   null                                  — not bookable that day
//   { start: 'HH:MM', end: 'HH:MM' }      — legacy single window (rows saved
//                                           before multiple windows existed)
//   [{ start, end }, { start, end }, ...] — what the form writes now
//
// Times are wall clock in the studio's zone. Both shapes stay readable for
// good: there is no backfill, a row moves to the list shape the next time
// its form is saved.
//
// Pure, no imports: the public BookingWidget (client) and the slot engine
// (server) both read it.

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

const DAY_LABELS = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
}

// '24:00' is end of day: the slot engine has always accepted it as an end.
const HHMM = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/

function hhmm(value) {
  const s = typeof value === 'string' ? value.slice(0, 5) : ''
  return HHMM.test(s) ? s : null
}

function rawWindows(day) {
  if (Array.isArray(day)) return day
  if (day && typeof day === 'object') return [day]
  return []
}

/**
 * The day's usable windows, sorted by start. Malformed or empty windows
 * (missing times, end not after start) are dropped, never thrown on: the
 * public widget must still render whatever is valid.
 * @param {object|null|undefined} availability
 * @param {string} dayKey  'mon' … 'sun'
 * @returns {Array<{ start: string, end: string }>}
 */
export function dayWindows(availability, dayKey) {
  if (!availability || typeof availability !== 'object') return []
  return rawWindows(availability[dayKey])
    .map((w) => (w && typeof w === 'object' ? { start: hhmm(w.start), end: hhmm(w.end) } : null))
    .filter((w) => w && w.start && w.end && w.start < w.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

/** Is the booking type bookable at all on this weekday? (An empty list is truthy — never test the raw value.) */
export function dayHasWindows(availability, dayKey) {
  return dayWindows(availability, dayKey).length > 0
}

/**
 * Why one day's windows can't be saved, or null. Windows may touch
 * (10:00–12:00 then 12:00–14:00) but not overlap.
 * @param {Array<{ start?: string, end?: string }>} windows
 * @returns {string|null}
 */
export function windowsIssue(windows) {
  const parsed = []
  for (const w of windows || []) {
    const start = hhmm(w?.start)
    const end = hhmm(w?.end)
    if (!start || !end) return 'Each window needs a start and an end time.'
    if (start >= end) return `${start}–${end} must end after it starts.`
    parsed.push({ start, end })
  }
  parsed.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1]
    const cur = parsed[i]
    if (cur.start < prev.end) return `${prev.start}–${prev.end} overlaps ${cur.start}–${cur.end}.`
  }
  return null
}

/**
 * Why a whole availability object can't be saved, or null. Accepts both
 * day shapes (API-key clients may still send the legacy one). The message
 * leads with the day so the form and the route can show it as-is.
 * @param {unknown} availability
 * @returns {string|null}
 */
export function availabilityIssue(availability) {
  if (availability == null) return null
  if (typeof availability !== 'object' || Array.isArray(availability)) {
    return 'Availability must be an object keyed by day.'
  }
  for (const [key, day] of Object.entries(availability)) {
    if (!DAY_KEYS.includes(key)) return `Unknown day "${key}".`
    if (day == null) continue
    if (typeof day !== 'object') return `${DAY_LABELS[key]}: each window needs a start and an end time.`
    const issue = windowsIssue(Array.isArray(day) ? day : [day])
    if (issue) return `${DAY_LABELS[key]}: ${issue}`
  }
  return null
}

/** '09:00–12:00, 17:00–20:00' */
export function formatWindows(windows) {
  return (windows || []).map((w) => `${w.start}–${w.end}`).join(', ')
}
