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

// ROSTER-FIX.7 — "today" for a roster is the STUDIO's day, not the phone's.
// Every UN1T studio is Europe/Dublin, and shift_date / time_off_requests dates
// are Dublin wall-clock (CLAUDE.md, "Timezones"). isoDate(new Date()) asks the
// device instead, so a phone left on a US timezone — travelling, a handset
// whose clock never picked the region up, an emulator — put the "today"
// highlight on the wrong column of the week grid and let the time-off
// calendar's minDate refuse a day that is still bookable in Dublin.
//
// formatToParts, not format(): en-IE renders dd/mm/yyyy, so the pieces are
// reassembled by NAME rather than sliced out of a locale-shaped string.
//
// ROSTER-FIX.7f — built LAZILY, not at module scope. A Hermes build without
// full ICU throws on `new Intl.DateTimeFormat(…, { timeZone })`, and a throw at
// module scope fails evaluation of dates.js itself, so every screen that
// imports a date helper white-screens rather than just losing the Dublin
// pin. Same shape as carMoney() in mobile/lib/cars-api.js: try the Intl path,
// fall back to the device date. Memoised on first success so the formatter is
// still built once, not once per render.
let dublinDayFmt = null
let dublinFmtWarned = false

function getDublinDayFmt() {
  if (dublinDayFmt) return dublinDayFmt
  dublinDayFmt = new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return dublinDayFmt
}

export function dublinTodayIso(now = new Date()) {
  try {
    const parts = {}
    for (const p of getDublinDayFmt().formatToParts(now)) parts[p.type] = p.value
    return `${parts.year}-${parts.month}-${parts.day}`
  } catch (err) {
    // Once per session: a phone on Dublin time (almost all of them) is
    // unaffected, so this is a degradation to log, not an error to shout.
    if (!dublinFmtWarned) {
      dublinFmtWarned = true
      console.warn('dublinTodayIso: Intl unavailable, falling back to the device date', err)
    }
    return isoDate(now)
  }
}
