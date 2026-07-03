// Tiny date helpers — no third-party date lib to keep the bundle slim.
//
// Everything that the schedule UI cares about happens in local time on
// the user's device. The CRM stores shifts as (shift_date YYYY-MM-DD,
// start_time HH:MM, end_time HH:MM) so there's no timezone arithmetic
// to worry about — we just format and compare ISO date strings.

export function isoDate(d) {
  // YYYY-MM-DD in local time (matches what shifts.shift_date stores).
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Parse a YYYY-MM-DD string into a local-time Date (midnight). Returns
// null for anything malformed or impossible (e.g. 2026-02-31), so it's
// safe to feed values arriving from route params / push payloads.
// Deliberately NOT `new Date('YYYY-MM-DD')` — that parses as UTC
// midnight and shifts a day in negative-offset timezones.
export function parseIsoDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null
  const [y, m, d] = str.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return isoDate(date) === str ? date : null
}

// Monday of the week containing `date` (Monday=0 ... Sunday=6 layout
// matches the web schedule grid).
export function weekStart(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const dow = d.getDay() // 0 = Sun
  const diff = dow === 0 ? -6 : 1 - dow
  d.setDate(d.getDate() + diff)
  return d
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

// ['Mon', 'Tue', ..., 'Sun']
export function daysOfWeek(start) {
  const out = []
  for (let i = 0; i < 7; i++) out.push(addDays(start, i))
  return out
}

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function shortDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function timeRange(start, end) {
  // start/end are HH:MM or HH:MM:SS strings.
  const trim = s => (s || '').slice(0, 5)
  return `${trim(start)} – ${trim(end)}`
}

// Hours between two HH:MM(:SS) strings on the same date. Crosses midnight
// is handled — anything ending earlier than start is treated as next-day.
export function hoursBetween(start, end) {
  const [sh, sm] = (start || '0:0').split(':').map(Number)
  const [eh, em] = (end || '0:0').split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}
