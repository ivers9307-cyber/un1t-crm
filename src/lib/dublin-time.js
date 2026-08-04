// dublin-time — small helpers for Europe/Dublin time on the server
// (Vercel runs in UTC). Hard-codes the timezone because UN1T is a
// Dublin-only business; if a second tenant timezone ever lands,
// thread the IANA zone through as a parameter.
//
// Why this exists: most date math in this codebase treats dates as
// timezoneless calendar strings (YYYY-MM-DD) — that's correct for
// stored shift dates, booking dates, etc. But anywhere we need to
// know "is this date today?" or "what's the current time?", the
// answer depends on the operator/customer timezone, not the server
// timezone. Without these helpers, the slots API was happily
// returning slots that had already passed in Dublin local time
// because it compared slot times (Dublin) to UTC clock time.

const DUBLIN_TZ = 'Europe/Dublin'

/**
 * Returns the Europe/Dublin calendar day (YYYY-MM-DD) for an arbitrary instant
 * (Date | epoch-ms | ISO string). This is the day-boundary any Dublin streak /
 * "same day?" logic must key off — a UTC day boundary mis-buckets a late-evening
 * Dublin session during BST (e.g. 23:30 Dublin = 22:30 UTC same day, but a
 * midnight-adjacent session can flip). sv-SE formats as YYYY-MM-DD natively.
 * @param {Date|number|string} [instant=Date.now()]
 */
export function dublinDayStr(instant = Date.now()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: DUBLIN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(instant instanceof Date ? instant : new Date(instant))
}

/**
 * Returns today's date in Europe/Dublin as a YYYY-MM-DD string.
 * sv-SE locale formats as YYYY-MM-DD natively (more reliable than
 * en-* locales which return D/M/YYYY).
 */
export function dublinTodayStr() {
  return dublinDayStr(new Date())
}

/**
 * Returns the Europe/Dublin calendar month (YYYY-MM) for an arbitrary instant.
 * The `period_month` key used for banked monthly targets is a Dublin month;
 * a late-evening session near a month boundary during BST would mis-bucket
 * under a UTC month, so tier-window math must derive "current month" from this.
 * @param {Date|number|string} [instant=Date.now()]
 */
export function dublinMonthStr(instant = Date.now()) {
  return dublinDayStr(instant).slice(0, 7)
}

/**
 * Returns the current time in Europe/Dublin as minutes since
 * midnight (0-1439). Used by slot generators to filter "past" slots
 * for the current day — slot.start strings are stored as Dublin
 * local time so the comparison must also be in Dublin time.
 */
export function dublinNowMinutes() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: DUBLIN_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date())
  const h = Number(parts.find((p) => p.type === 'hour').value)
  const m = Number(parts.find((p) => p.type === 'minute').value)
  return h * 60 + m
}

/**
 * Add N calendar days to a YYYY-MM-DD string and return the
 * resulting YYYY-MM-DD string. Pure date math — no timezone
 * involved (the input/output are both timezoneless calendar
 * dates), but we use UTC under the hood to avoid the local-DST
 * gotcha where setDate() can skip or duplicate hours.
 */
export function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Format a UTC instant (ISO string) as a Dublin wall-clock HH:MM (24h, DST-safe
 * via Intl). Returns null for an unparseable input.
 */
export function dublinTimeLabel(iso) {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(t))
}

// ---------------------------------------------------------------------------
// Europe/Dublin day-boundary helpers — kept behaviour-identical to
// champ-app/shared/dublin-time.js so the byte-synced twin
// src/lib/challenges.js computes the same challenge windows on both surfaces.
// Semantics: a "training day" is a Europe/Dublin calendar day. A window that
// runs [D1 .. D2] inclusive spans the half-open UTC instant range
// [00:00 Europe/Dublin on D1, 00:00 Europe/Dublin on (D2 + 1 day)). "Midnight"
// always means Dublin local midnight (UTC+00:00 in GMT, UTC-01:00 in IST).
// MUST match the un1t-crm challenge_standings RPC day boundaries.

const DAY_MS = 24 * 3600 * 1000

// 'en-CA' formats as 'YYYY-MM-DD'; the timeZone does the GMT/IST shift.
const _dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: DUBLIN_TZ })

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
  timeZone: DUBLIN_TZ,
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
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0)
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

export { DAY_MS as DUBLIN_DAY_MS }
