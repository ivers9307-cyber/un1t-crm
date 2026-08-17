// Canonical Europe/Dublin day-boundary helpers. THE single source of
// truth for "what calendar day is this instant" across champ-app +
// un1t-crm shared logic (streaks, challenge windows, goal periods,
// push idempotency keys).
//
// Why this module exists
// ----------------------
// heart_rate_sessions.started_at / ended_at are real timestamptz
// instants. UN1T is a Dublin gym: a "training day" is a Europe/Dublin
// calendar day, NOT a UTC day. During IST (BST, UTC+1, late-Mar → late-
// Oct) a session at 23:30 Dublin is already 22:30 the SAME UTC day, but
// a session at 00:30 Dublin is 23:30 the PREVIOUS UTC day. Bucketing on
// UTC therefore mis-assigns any session within an hour of midnight for
// half the year — producing contradictory member-visible numbers (a
// 5-day streak in the app but "4-day" in the email; a session credited
// to the wrong challenge/goal window).
//
// Semantics implemented here (mirror these in the un1t-crm
// challenge_standings RPC): a day is the Europe/Dublin calendar day.
// A window/period that runs [D1 .. D2] inclusive spans the half-open
// UTC instant range [00:00 Europe/Dublin on D1, 00:00 Europe/Dublin on
// (D2 + 1 day)). "Midnight" always means Dublin local midnight, whose
// UTC offset is +00:00 in GMT and -01:00 (i.e. 23:00 UTC the prior day)
// in IST.
//
// No IO, no deps beyond Intl. Pure + fixture-testable.

const DAY_MS = 24 * 3600 * 1000

// 'en-CA' formats as 'YYYY-MM-DD'; the timeZone does the GMT/IST shift.
const _dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' })

/**
 * Europe/Dublin calendar day key ('YYYY-MM-DD') for a UTC instant.
 * Accepts a ms epoch, a Date, or an ISO/timestamptz string.
 * @param {number|string|Date} isoOrMs
 * @returns {string} 'YYYY-MM-DD' in Europe/Dublin
 */
export function dublinDateKey(isoOrMs) {
  return _dayFmt.format(new Date(isoOrMs))
}

// Europe/Dublin wall-clock parts (Y/M/D/H/Min/S) for a UTC instant.
const _partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})
function dublinParts(ms) {
  const p = {}
  for (const { type, value } of _partsFmt.formatToParts(new Date(ms))) p[type] = value
  // 'en-GB' can emit hour '24' at midnight; normalise to 0.
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    h: hour, mi: Number(p.minute), s: Number(p.second),
  }
}

/**
 * UTC-ms instant of 00:00 Europe/Dublin on the given calendar date.
 *
 * Robust across the DST transitions: we take the naive UTC-midnight for
 * the date, read back what Dublin wall-clock that instant actually is,
 * and correct by the observed offset. One correction pass is exact for
 * Dublin's ±1h DST (the corrected instant never lands in the ambiguous
 * hour of a transition for a *midnight* target — spring-forward skips
 * 01:00→02:00, fall-back repeats 01:00→02:00, neither straddles 00:00).
 *
 * @param {string|{y:number,mo:number,d:number}} date  'YYYY-MM-DD' or parts
 * @returns {number} UTC ms epoch of Dublin local midnight
 */
export function dublinDayStartMs(date) {
  let y, mo, d
  if (typeof date === 'string') {
    ;[y, mo, d] = date.split('-').map(Number)
  } else {
    ;({ y, mo, d } = date)
  }
  // Naive guess: treat the wanted wall-clock as if it were UTC.
  let guess = Date.UTC(y, mo - 1, d, 0, 0, 0)
  // How far off is Dublin wall-clock at that instant from 00:00?
  const p = dublinParts(guess)
  const wallMsFromMidnight =
    ((p.h * 60 + p.mi) * 60 + p.s) * 1000
  // Dublin is ahead of UTC by (wall - utc); to land Dublin on 00:00 we
  // subtract that offset. In GMT wall==0 → no shift; in IST wall==01:00
  // → subtract 1h (so the instant is 23:00 UTC the previous day).
  return guess - wallMsFromMidnight
}

/**
 * Half-open UTC-ms window [start, endExclusive) for an inclusive
 * Europe/Dublin calendar-day range [startDate .. endDate].
 * @param {string} startDate 'YYYY-MM-DD'
 * @param {string} endDate   'YYYY-MM-DD' (inclusive)
 * @returns {{startMs:number, endMs:number}}
 */
export function dublinDayRangeMs(startDate, endDate) {
  const startMs = dublinDayStartMs(startDate)
  // end-exclusive = start of the day AFTER endDate.
  const endMs = dublinDayStartMs(dublinDateKey(dublinDayStartMs(endDate) + DAY_MS))
  return { startMs, endMs }
}

/**
 * Europe/Dublin calendar day → the calendar day `n` days before/after,
 * as a 'YYYY-MM-DD' key. Walks via Dublin midnights so it never drifts
 * across a DST edge.
 * @param {string} dateKey 'YYYY-MM-DD'
 * @param {number} n days to add (negative to subtract)
 */
export function dublinAddDays(dateKey, n) {
  // Anchor at noon Dublin then step whole days: noon is far from both
  // DST transition hours, so + n*DAY stays on the intended calendar day
  // regardless of a 23h or 25h civil day in between.
  const noonMs = dublinDayStartMs(dateKey) + 12 * 3600 * 1000
  return dublinDateKey(noonMs + n * DAY_MS)
}

/**
 * Europe/Dublin ISO-week idempotency/period key.
 * Returns 'YYYY-Www' where the week is the ISO-8601 week that the
 * Dublin calendar day belongs to (weeks start Monday; the week-year can
 * differ from the calendar year near Jan 1 / Dec 31).
 * @param {number|string|Date} isoOrMs
 */
export function dublinIsoWeekKey(isoOrMs) {
  const [y, m, d] = dublinDateKey(isoOrMs).split('-').map(Number)
  // Work in a UTC proxy Date for the pure calendar arithmetic — no tz
  // math needed once we're on the Dublin calendar date.
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = (date.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // Thursday of this ISO week
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7
  const week = 1 + Math.round(((date - firstThursday) / DAY_MS - 3 + ftDayNum) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

/**
 * Europe/Dublin month key 'YYYY-MM' for a UTC instant.
 * @param {number|string|Date} isoOrMs
 */
export function dublinMonthKey(isoOrMs) {
  return dublinDateKey(isoOrMs).slice(0, 7)
}

/**
 * UTC-ms start of the Europe/Dublin ISO week (Monday 00:00 Dublin)
 * containing the given instant.
 * @param {number|string|Date} isoOrMs
 */
export function dublinWeekStartMs(isoOrMs) {
  const key = dublinDateKey(isoOrMs)
  const [y, m, d] = key.split('-').map(Number)
  const dayNum = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 // Mon=0
  const mondayKey = dublinAddDays(key, -dayNum)
  return dublinDayStartMs(mondayKey)
}

/**
 * UTC-ms start of the Europe/Dublin calendar month (1st 00:00 Dublin)
 * containing the given instant.
 * @param {number|string|Date} isoOrMs
 */
export function dublinMonthStartMs(isoOrMs) {
  const [y, m] = dublinDateKey(isoOrMs).split('-').map(Number)
  return dublinDayStartMs({ y, mo: m, d: 1 })
}

export { DAY_MS as DUBLIN_DAY_MS }
