// Date formatters — single source of truth for the patterns
// repeated across 42 files in the web codebase.
//
// Why this exists
//   • Inconsistent locale: callers mix '`en-IE'`, '`en-GB'`, and the
//     plain `toLocaleDateString()` (which uses the runtime default
//     and produces different output on the server vs the browser).
//   • date-only column gotcha: bare `YYYY-MM-DD` strings parse as
//     UTC midnight — when rendered in Dublin (UTC+1 BST) they
//     display as "the day before". Every caller works around this
//     with `new Date(d + 'T00:00:00')`. Forgetting the suffix is
//     how the Monday-off-by-one bug shipped (task #240).
//   • Bundle drag: 42 ad-hoc Intl.DateTimeFormat usages × multiple
//     option bags = a lot of formatters constructed per render.
//     Reusing module-level Intl instances is materially cheaper.
//
// Conventions used by the helpers
//   • Locale is hard-coded to 'en-IE' (UN1T's primary market).
//     CCF Autos shares the same locale. If we ever need US/UK
//     localisation we add a second locale arg; today we don't.
//   • All date-only strings ('YYYY-MM-DD' from a Postgres date
//     column) go through `parseDateOnly` which fixes the TZ bug.
//   • Time-of-day strings ('HH:MM' / 'HH:MM:SS') are passed
//     through trimming the seconds; we don't construct a Date
//     for them (no local-vs-UTC ambiguity to worry about).
//
// Naming
//   • format*  — produce a human string for display
//   • parse*   — convert a known shape into a Date
//   • is*      — predicate
//
// The functions below cover ~95% of the existing usage. Any
// formatter that doesn't match a pattern here lives in the calling
// component's local helper.

const LOCALE = 'en-IE'

// Module-level Intl instances. Reused across calls for cheaper
// rendering — Intl.DateTimeFormat construction is non-trivial.
const FMT = {
  // "8 May"
  shortDate: new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' }),
  // "Thu, 8 May"
  weekdayShortDate: new Intl.DateTimeFormat(LOCALE, {
    weekday: 'short', day: 'numeric', month: 'short',
  }),
  // "Thursday, 8 May"
  weekdayLongDate: new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long', day: 'numeric', month: 'long',
  }),
  // "May 2026"
  monthYear: new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }),
  // "8 May 2026"
  fullDate: new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric', month: 'short', year: 'numeric',
  }),
  // "14:30"
  timeOnly: new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit', minute: '2-digit',
  }),
  // "8 May, 14:30"
  shortDateTime: new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }),
  // "Thu, 8 May, 14:30"
  weekdayShortDateTime: new Intl.DateTimeFormat(LOCALE, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  }),
}

/**
 * Parse a date-only column ('YYYY-MM-DD') as the start of that
 * day in *local* time, not UTC midnight. This is the single
 * hot-spot that has caused TZ bugs in the past.
 *
 * Pass anything that's already a Date through unchanged. Pass
 * an ISO timestamp (with 'T') through unchanged too (the TZ
 * trick only matters for bare date strings).
 *
 * @param {string|Date|null|undefined} value
 * @returns {Date|null}
 */
export function parseDateOnly(value) {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value !== 'string') return null
  // Already a full ISO with time — let Date handle it normally.
  if (value.includes('T')) return new Date(value)
  // Bare YYYY-MM-DD: append local-midnight to dodge UTC parsing.
  return new Date(`${value}T00:00:00`)
}

/** "8 May" */
export function formatShortDate(value) {
  const d = parseDateOnly(value)
  return d ? FMT.shortDate.format(d) : ''
}

/** "Thu, 8 May" */
export function formatWeekdayShortDate(value) {
  const d = parseDateOnly(value)
  return d ? FMT.weekdayShortDate.format(d) : ''
}

/** "Thursday, 8 May" */
export function formatWeekdayLongDate(value) {
  const d = parseDateOnly(value)
  return d ? FMT.weekdayLongDate.format(d) : ''
}

/** "May 2026" */
export function formatMonthYear(value) {
  const d = parseDateOnly(value)
  return d ? FMT.monthYear.format(d) : ''
}

/** "8 May 2026" */
export function formatFullDate(value) {
  const d = parseDateOnly(value)
  return d ? FMT.fullDate.format(d) : ''
}

/** "14:30" — accepts a Date or an ISO timestamp string. */
export function formatTimeOnly(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return FMT.timeOnly.format(d)
}

/** "8 May, 14:30" — for ISO timestamps in tables. */
export function formatShortDateTime(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return FMT.shortDateTime.format(d)
}

/** "Thu, 8 May, 14:30" — for activity timelines. */
export function formatWeekdayShortDateTime(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return FMT.weekdayShortDateTime.format(d)
}

/**
 * Trim seconds from an 'HH:MM' or 'HH:MM:SS' string. We never want
 * to display seconds in the UI; this is the single function that
 * enforces it.
 *
 * @param {string|null|undefined} value
 * @returns {string} 'HH:MM' or '' if input was empty/invalid
 */
export function formatTimeStr(value) {
  if (!value || typeof value !== 'string') return ''
  return value.slice(0, 5)
}

/**
 * "09:00 – 18:00" given two HH:MM strings. Used in roster + booking
 * UIs so we have one place to change the en-dash → em-dash style.
 */
export function formatTimeRange(start, end) {
  return `${formatTimeStr(start)} – ${formatTimeStr(end)}`
}

/**
 * Compact relative timestamp: "just now" / "5 min ago" / "2h ago" /
 * "Mon, 6 May" for older. Used in activity feeds / inbox headers
 * where Slack-style recency is more useful than an absolute date.
 *
 * @param {string|Date|null|undefined} value
 * @param {Date} [now] — testable clock
 * @returns {string}
 */
export function formatRelative(value, now = new Date()) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 7) return `${diffD}d ago`
  return formatWeekdayShortDate(d)
}

/**
 * 'YYYY-MM-DD' for the *local* day. Mirrors mobile/lib/dates.js's
 * isoDate so web + mobile agree on date-only strings.
 *
 * @param {Date} d
 * @returns {string}
 */
export function isoDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True if two date-onlys / Dates fall on the same local day. */
export function isSameDay(a, b) {
  const da = parseDateOnly(a)
  const db = parseDateOnly(b)
  if (!da || !db) return false
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate()
}
