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
