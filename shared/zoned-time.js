// shared/zoned-time.js — TZ.1. THE zone maths for web, server, phone and champ-app.
// Pure: no IO, no imports, no host-zone reads. Safe on Hermes (never calls
// Intl.supportedValuesOf unguarded; builds every formatter lazily, so importing
// this module can never throw on a build without full ICU).
//
// Contract:
//   • every `*In(…, zone)` is a DROP-IN for the dublin-time export of the same
//     shape (same inputs, same edge behaviour incl. what throws) and is
//     byte-identical to it for Europe/Dublin (shared/zoned-time.parity.test.js:
//     every hour of 2025-2027, every DST-edge minute, every calendar day).
//     Name map: dublinDayStr → dayStrIn, dublinTodayStr → todayStrIn,
//     dublinMonthStr → monthStrIn, dublinNowMinutes → nowMinutesIn,
//     dublinTimeLabel → timeLabelIn, dublinDateKey → dateKeyIn,
//     dublinDayStartMs → dayStartMsIn, dublinDayRangeMs → dayRangeMsIn,
//     dublinAddDays → addDaysIn, dublinIsoWeekKey → isoWeekKeyIn,
//     dublinMonthKey → monthKeyIn, dublinWeekStartMs → weekStartMsIn,
//     dublinMonthStartMs → monthStartMsIn, DUBLIN_DAY_MS → DAY_MS.
//   • the wall-clock solver is tz-time's (SHELLY.1): two correction passes,
//     0 errors in 12 zones 2025-2027. GAP (spring forward): a nonexistent
//     wall-clock resolves EARLIER, except a day START, which resolves LATER (the
//     first instant of the day). OVERLAP (fall back): one deterministic instant.
//   • `zone` is an IANA name. Callers resolve a location's column through
//     resolveZone()/getLocationZone() first; a raw invalid string reaching a
//     formatter throws RangeError, as Intl does.
//   • Wall-clock columns (booking_date + start_time, shift_blocks, race_events,
//     Sonos windows, …) are LOCAL to the owning row's location: convert them
//     with zonedWallClockToInstant(date, time, zone) at read time. An instant
//     (any *_at timestamptz) is never re-zoned; only its rendering and its day
//     bucket take a zone.
//
// Canonical names: Intl canonicalises some IANA names to their legacy LINK
// (V8/Node 24: 'Asia/Kolkata' → 'Asia/Calcutta', 'Europe/Kyiv' → 'Europe/Kiev').
// Both spellings are valid zones with identical rules, so canonicalZone() may
// return either; compare zones through canonicalZone(), never as raw strings.

export const PLATFORM_TZ = 'Europe/Dublin'
export const DEFAULT_TZ = PLATFORM_TZ
export const DAY_MS = 24 * 3600 * 1000

// ── zone validation ────────────────────────────────────────────────────────
// Fixed offsets have no DST, so accepting one is silently an hour wrong for half
// the year: rejected by shape before Intl ever sees them. ('Etc/GMT', 'Etc/UTC'
// and bare 'GMT' pass: Intl canonicalises them to plain 'UTC', no DST hazard.)
const FIXED_OFFSET = /^(?:[+-]\d|(?:Etc\/)?GMT[+-]\d|UTC[+-]\d)/i
let _supported // undefined = not built; null = runtime has no supportedValuesOf (Hermes)
function supportedZones() {
  if (_supported === undefined) {
    _supported = typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('timeZone')) : null
  }
  return _supported
}
// POSITIVE-only cache, keyed lower-cased: a failed lookup is never stored, so
// garbage input cannot grow the Map; it is bounded by the IANA set.
const _canon = new Map()
/** Canonical IANA name for `tz`, or null if it is not one (fixed offsets rejected). */
export function canonicalZone(tz) {
  if (typeof tz !== 'string') return null
  const raw = tz.trim()
  if (!raw || raw.length > 64 || FIXED_OFFSET.test(raw)) return null
  const key = raw.toLowerCase()
  const hit = _canon.get(key)
  if (hit !== undefined) return hit
  let canon
  try { canon = new Intl.DateTimeFormat('en-GB', { timeZone: raw }).resolvedOptions().timeZone } catch { return null }
  if (!canon || FIXED_OFFSET.test(canon)) return null
  const list = supportedZones()
  if (list && canon !== 'UTC' && !list.has(canon)) return null
  _canon.set(key, canon)
  return canon
}
export const isValidZone = (tz) => canonicalZone(tz) !== null
/** The canonical zone, or the Dublin floor for null/blank/invalid input. Never throws. */
export const resolveZone = (tz) => canonicalZone(tz) ?? DEFAULT_TZ
/** As resolveZone, plus `fallback: true` only for a non-null INVALID value (worth a warning). */
export function resolveZoneWithFallback(tz) {
  const canon = canonicalZone(tz)
  return canon ? { zone: canon, fallback: false } : { zone: DEFAULT_TZ, fallback: tz != null }
}

// ── formatter caches (lazy: nothing is built at import) ─────────────────────
const _fmts = new Map()
function fmt(kind, zone, locale, opts) {
  const k = `${kind}|${locale}|${zone}`
  let f = _fmts.get(k)
  if (!f) { f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone }); _fmts.set(k, f) }
  return f
}
const dayFmt = (z) => fmt('day', z, 'sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }) // = dublinDayStr
const keyFmt = (z) => fmt('key', z, 'en-CA', {}) // = dublinDateKey
const hmFmt = (z) => fmt('hm', z, 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) // = dublinNowMinutes / dublinTimeLabel
const partsFmt = (z) => fmt('parts', z, 'en-GB', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short', hourCycle: 'h23',
})
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

// ── instant → parts / keys ─────────────────────────────────────────────────
/**
 * Wall-clock parts of an instant in `zone`.
 * @param {Date|number|string} instant
 * @returns {{y:number,mo:number,d:number,h:number,mi:number,s:number,weekday:number,dateKey:string,minuteOfDay:number}}
 *   weekday is ISO: 1 = Monday … 7 = Sunday.
 */
export function instantToZonedParts(instant, zone = DEFAULT_TZ) {
  const ms = instant instanceof Date ? instant.getTime() : (typeof instant === 'string' ? Date.parse(instant) : instant)
  const p = {}
  for (const { type, value } of partsFmt(zone).formatToParts(new Date(ms))) p[type] = value
  // hourCycle 'h23' should rule out '24'; the guard dublin-time carries costs nothing.
  const h = p.hour === '24' ? 0 : Number(p.hour)
  const out = { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h, mi: Number(p.minute), s: Number(p.second), weekday: WEEKDAY[p.weekday] }
  out.dateKey = `${p.year}-${p.month}-${p.day}`
  out.minuteOfDay = h * 60 + out.mi
  return out
}
/** Calendar day 'YYYY-MM-DD' of an instant in `zone` (twin of dublinDayStr). */
export function dayStrIn(instant = Date.now(), zone = DEFAULT_TZ) {
  return dayFmt(zone).format(instant instanceof Date ? instant : new Date(instant))
}
/** Today 'YYYY-MM-DD' in `zone` (twin of dublinTodayStr). */
export const todayStrIn = (zone = DEFAULT_TZ, nowMs = Date.now()) => dayStrIn(new Date(nowMs), zone)
/** 'YYYY-MM' of an instant in `zone` (twin of dublinMonthStr). */
export const monthStrIn = (instant = Date.now(), zone = DEFAULT_TZ) => dayStrIn(instant, zone).slice(0, 7)
/** Minutes since local midnight (0-1439) now in `zone` (twin of dublinNowMinutes). */
export function nowMinutesIn(zone = DEFAULT_TZ, nowMs = Date.now()) {
  const parts = hmFmt(zone).formatToParts(new Date(nowMs))
  return Number(parts.find((x) => x.type === 'hour').value) * 60 + Number(parts.find((x) => x.type === 'minute').value)
}
/** 'HH:MM' (24h) of an ISO instant in `zone`, or null if unparseable (twin of dublinTimeLabel). */
export function timeLabelIn(iso, zone = DEFAULT_TZ) {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  return hmFmt(zone).format(new Date(t))
}
/** Calendar day key 'YYYY-MM-DD' of an instant in `zone` (twin of dublinDateKey). */
export const dateKeyIn = (isoOrMs, zone = DEFAULT_TZ) => keyFmt(zone).format(new Date(isoOrMs))
/** Month key 'YYYY-MM' of an instant in `zone` (twin of dublinMonthKey). */
export const monthKeyIn = (isoOrMs, zone = DEFAULT_TZ) => dateKeyIn(isoOrMs, zone).slice(0, 7)
/** Intl formatting of an instant in `zone`; formatters cached per (locale, zone, options). */
export function formatInZone(instant, zone = DEFAULT_TZ, options = {}, locale = 'en-IE') {
  const k = `fmt|${locale}|${zone}|${JSON.stringify(options)}`
  let f = _fmts.get(k)
  if (!f) { f = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }); _fmts.set(k, f) }
  return f.format(instant instanceof Date ? instant : new Date(instant))
}

// ── the solver (tz-time's, verbatim in behaviour) ──────────────────────────
// Wall clock in `zone` at `ms`, re-encoded as if it were UTC ("naive" ms), to the minute.
function naiveWallMs(ms, zone) {
  const p = instantToZonedParts(ms, zone)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)
}
// The zone's UTC offset at `ms` (east of UTC positive). `ms` is floored to the
// minute because naiveWallMs is minute-resolution; every input here is.
const offsetMsAt = (ms, zone) => naiveWallMs(ms, zone) - Math.floor(ms / 60_000) * 60_000
// Solve ms + offset(ms) = want. Pass 1 samples the offset at `want` itself, the
// wrong side of a transition for a band of times on each DST day in any zone
// whose standard offset is not 0; pass 2 re-samples at that candidate.
// `gapPrefer` only applies when `want` does not exist (spring-forward gap).
function solveWallMs(want, zone, gapPrefer) {
  const ms1 = want - offsetMsAt(want, zone)
  const ms2 = want - offsetMsAt(ms1, zone)
  if (ms1 === ms2) return ms1
  if (naiveWallMs(ms2, zone) === want) return ms2
  return gapPrefer === 'later' ? Math.max(ms1, ms2) : Math.min(ms1, ms2)
}
// 'YYYY-MM-DD' → parts, or null for anything that is not a real calendar date
// (Date.UTC would roll Feb 30 over into March).
function parseYmd(dateStr) {
  const m = String(dateStr ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const back = new Date(Date.UTC(y, mo - 1, d))
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null
  return { y, mo, d }
}

/**
 * Wall clock 'HH:MM' or 'HH:MM:SS' (a Postgres TIME) on a calendar date in
 * `zone` → UTC ms. null for a malformed or nonexistent date/time: callers skip,
 * never roll over.
 */
export function zonedWallClockToInstant(dateStr, time, zone = DEFAULT_TZ) {
  const t = String(time ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/)
  if (!t) return null
  const ymd = parseYmd(dateStr)
  if (!ymd) return null
  const want = Date.UTC(ymd.y, ymd.mo - 1, ymd.d, Number(t[1]), Number(t[2]))
  return solveWallMs(want, zone, 'earlier') + Number(t[3] || 0) * 1000
}

/**
 * UTC ms of 00:00 in `zone` on a date. DROP-IN for dublinDayStartMs: same
 * lenient parse (a rollover date rolls over, as Date.UTC does), same {y,mo,d}
 * input. Strict callers use strictDayStartMsIn.
 * @param {string|{y:number,mo:number,d:number}} date
 */
export function dayStartMsIn(date, zone = DEFAULT_TZ) {
  let y, mo, d
  if (typeof date === 'string') [y, mo, d] = date.split('-').map(Number)
  else ({ y, mo, d } = date)
  return solveWallMs(Date.UTC(y, mo - 1, d, 0, 0, 0), zone, 'later')
}
/** As dayStartMsIn, but null for anything that is not a real 'YYYY-MM-DD' date. */
export function strictDayStartMsIn(dateStr, zone = DEFAULT_TZ) {
  const ymd = parseYmd(dateStr)
  return ymd ? solveWallMs(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 0, 0), zone, 'later') : null
}
/**
 * 'YYYY-MM-DD' of an instant in `zone`; throws RangeError on null, '', NaN or
 * an unparseable string (where dayStrIn would return '1970-01-01' for null).
 */
export function strictDayStrIn(instant = Date.now(), zone = DEFAULT_TZ) {
  let ms
  if (instant instanceof Date) ms = instant.getTime()
  else if (typeof instant === 'number') ms = instant
  else if (typeof instant === 'string' && instant.trim()) ms = Date.parse(instant)
  else ms = NaN
  if (!Number.isFinite(ms)) throw new RangeError('strictDayStrIn: invalid instant')
  return instantToZonedParts(ms, zone).dateKey
}
/** The calendar day `n` days from `dateKey`, walking local noons (twin of dublinAddDays). */
export function addDaysIn(dateKey, n, zone = DEFAULT_TZ) {
  return dateKeyIn(dayStartMsIn(dateKey, zone) + 12 * 3600 * 1000 + n * DAY_MS, zone)
}
/** Half-open [startMs, endMs) for an inclusive local-day range (twin of dublinDayRangeMs). */
export function dayRangeMsIn(startDate, endDate, zone = DEFAULT_TZ) {
  return { startMs: dayStartMsIn(startDate, zone), endMs: dayStartMsIn(addDaysIn(endDate, 1, zone), zone) }
}
/** ISO-8601 week key 'YYYY-Www' of the local day (twin of dublinIsoWeekKey). */
export function isoWeekKeyIn(isoOrMs, zone = DEFAULT_TZ) {
  const [y, m, d] = dateKeyIn(isoOrMs, zone).split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7
  const week = 1 + Math.round(((date - firstThursday) / DAY_MS - 3 + ftDayNum) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}
/** UTC ms of Monday 00:00 local of the instant's ISO week (twin of dublinWeekStartMs). */
export function weekStartMsIn(isoOrMs, zone = DEFAULT_TZ) {
  const key = dateKeyIn(isoOrMs, zone)
  const [y, m, d] = key.split('-').map(Number)
  const dayNum = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
  return dayStartMsIn(addDaysIn(key, -dayNum, zone), zone)
}
/** UTC ms of the 1st 00:00 local of the instant's month (twin of dublinMonthStartMs). */
export function monthStartMsIn(isoOrMs, zone = DEFAULT_TZ) {
  const [y, m] = dateKeyIn(isoOrMs, zone).split('-').map(Number)
  return dayStartMsIn({ y, mo: m, d: 1 }, zone)
}
/** Pure calendar arithmetic on 'YYYY-MM-DD' (zone-free; same as dublin-time's). */
export function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
/** Next local midnight strictly after `instant` in `zone`. */
export function nextLocalMidnightMs(instant = Date.now(), zone = DEFAULT_TZ) {
  return strictDayStartMsIn(addDaysISO(strictDayStrIn(instant, zone), 1), zone)
}
