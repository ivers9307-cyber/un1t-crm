// src/lib/timezone-options.js — TZ.2. The location timezone picker's data and
// the D8 country hint. Pure (Intl only), so it runs in the browser: the
// creation forms (LocationForm, the tenant wizard) and settings import it.
//
// D1 = A: any IANA zone canonicalZone() accepts (fixed offsets refused). The
// server re-validates with the same canonicalZone() (POST /api/locations) and
// the DB with pg_timezone_names (mig 719), so this list is a convenience, not
// the fence.
import { canonicalZone, PLATFORM_TZ } from '@shared/zoned-time'

// Shown first in the picker, then every other zone the runtime knows. All are
// spelled as V8 canonicalises them (see allZones' test).
// PLATFORM_TZ is Europe/Dublin: here it is simply the first picker entry.
export const COMMON_ZONES = Object.freeze([
  PLATFORM_TZ, 'Europe/London', 'Europe/Berlin', 'Europe/Malta', 'Asia/Nicosia', 'Africa/Cairo', 'Asia/Kuwait',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
])

// The countries the location forms offer (drives the bank-holiday list,
// src/lib/bank-holidays.js; independent of the zone).
export const COUNTRY_OPTIONS = Object.freeze([
  { code: 'IE', label: 'Ireland (IE)' },
  { code: 'GB', label: 'United Kingdom (GB)' },
  { code: 'DE', label: 'Germany (DE)' },
  { code: 'AU', label: 'Australia (AU)' },
  { code: 'KW', label: 'Kuwait (KW)' },
  { code: 'MT', label: 'Malta (MT)' },
  { code: 'EG', label: 'Egypt (EG)' },
  { code: 'CY', label: 'Cyprus (CY)' },
])

let _all
/** COMMON_ZONES, then every other runtime zone; canonical spellings, no duplicates. */
export function allZones() {
  if (_all) return _all
  const rest = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  const seen = new Set(COMMON_ZONES)
  const out = [...COMMON_ZONES]
  for (const z of rest) {
    const canon = canonicalZone(z)
    if (!canon || canon === 'UTC' || seen.has(canon)) continue
    seen.add(canon)
    out.push(canon)
  }
  _all = Object.freeze(out)
  return _all
}

// D8 hint: the zones a country plausibly uses. A trailing '/' is a prefix.
const COUNTRY_ZONES = Object.freeze({
  IE: [PLATFORM_TZ], GB: ['Europe/London'], DE: ['Europe/Berlin', 'Europe/Busingen'], MT: ['Europe/Malta'],
  CY: ['Asia/Nicosia', 'Asia/Famagusta'], EG: ['Africa/Cairo'], KW: ['Asia/Kuwait'],
  AU: ['Australia/', 'Antarctica/Macquarie'], US: ['America/', 'Pacific/Honolulu'],
})

/**
 * A warning when the zone looks wrong for the country (D8), else null. Never a
 * block: a studio may legitimately sit on another zone.
 */
export function countryZoneMismatch(country, zone) {
  const code = String(country || '').trim().toUpperCase()
  const want = COUNTRY_ZONES[code]
  const canon = canonicalZone(zone)
  if (!want || !canon) return null
  const fits = want.some((p) => (p.endsWith('/') ? canon.startsWith(p) : canon === canonicalZone(p)))
  return fits ? null : `Country is ${code} but the timezone is ${canon}. Is that right?`
}

/**
 * The creating browser's zone, canonical (D8 pre-fill), or null when the
 * runtime gives no real signal: UTC (privacy modes and servers report it; no
 * studio runs on UTC) or an unknown name.
 */
export function browserZone(runtimeZone = runtimeTimeZone()) {
  const canon = canonicalZone(runtimeZone)
  return canon && canon !== 'UTC' ? canon : null
}
function runtimeTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return null }
}

const _offsetFmts = new Map()
/** The zone's UTC offset at `nowMs`, as Intl's shortOffset ('GMT+0', 'GMT+1', 'GMT-5', 'GMT+5:30'); '' if invalid. */
export function zoneOffsetLabel(zone, nowMs = Date.now()) {
  try {
    let f = _offsetFmts.get(zone)
    if (!f) {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' })
      _offsetFmts.set(zone, f)
    }
    return f.formatToParts(new Date(nowMs)).find((p) => p.type === 'timeZoneName')?.value || ''
  } catch {
    return ''
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[_\s]+/g, ' ').trim()
/** Zones whose name contains the query (case-insensitive; a space matches '_'). Empty query → `zones` itself. */
export function filterZones(zones, query) {
  const q = norm(query)
  if (!q) return zones
  return zones.filter((z) => norm(z).includes(q))
}
