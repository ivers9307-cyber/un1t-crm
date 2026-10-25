// shared/zone-suffix.js — THE "name the zone only when it is not the viewer's"
// rule (TZ decision D3 = A), one implementation for the web and the phone.
//
// A staff screen shows a record's instant in the RECORD's studio zone (a 09:00
// class in New York reads "09:00" to everyone who runs it). When that zone is
// not the viewer's own, the time carries the zone's abbreviation ("09:00 EST")
// so a manager in Dublin knows whose 09:00 it is. A Dublin record seen from
// Dublin, or by a viewer whose zone is unknown, carries nothing: today's text.
//
// Consumers: src/lib/record-time.js (TZ.16, web; re-exports every name here,
// tests/shared-pair-sync.test.js holds it to runtime identity) and
// mobile/lib/studio-zone.js (TZ.14, phone; wraps these with the device zone as
// the default viewer). Before this module each kept its own copy.
//
// Pure: no IO, no React. Hermes-safe: nothing is built at import; every Intl
// formatter is built lazily, cached, and a runtime that cannot build one (no
// timeZoneName support) falls through to the next locale, then the city.

import { canonicalZone, resolveZone } from './zoned-time.js'

/** Same zone, compared through canonicalZone (Asia/Kolkata = Asia/Calcutta). False when either is invalid. */
export function sameZone(a, b) {
  const ca = canonicalZone(a)
  return ca !== null && ca === canonicalZone(b)
}

/**
 * Should a time in `zone` carry its abbreviation for this viewer?
 * An unknown or invalid viewer zone never asks for a suffix; an unresolvable
 * record zone is the Dublin floor (resolveZone).
 * @param {string|null|undefined} zone the record's zone
 * @param {string|null|undefined} viewerZone
 */
export function needsZoneSuffix(zone, viewerZone) {
  const viewer = canonicalZone(viewerZone)
  if (!viewer) return false
  return resolveZone(zone) !== viewer
}

/**
 * The zone named by its city ("Dublin", "New York", "Buenos Aires").
 * Unknown → the Dublin floor.
 * @param {string|null|undefined} zone
 */
export function zoneCity(zone) {
  const z = resolveZone(zone)
  return z.slice(z.lastIndexOf('/') + 1).replace(/_/g, ' ')
}

// The first locale whose short name for the zone is a LETTERED abbreviation
// wins: en-US names the Americas (EST/EDT), en-GB the UK and central Europe
// (BST, CEST), en-IE Ireland's summer time (IST), en-AU Australia's (AEST).
// Else the offset form ("GMT+9", "GMT+5:30"), else the city, so the suffix is
// never silently empty. (The web's old "not a bare offset" test and the
// phone's old "lettered" test agreed on every IANA zone, Jan and Jul 2026.)
const ABBR_LOCALES = ['en-US', 'en-GB', 'en-IE', 'en-AU']
const LETTERED = /^[A-Z]{2,5}$/
const _fmts = new Map() // `${locale}|${zone}` → formatter, or null when the runtime cannot build it
function shortName(locale, zone, d) {
  const k = `${locale}|${zone}`
  let f = _fmts.get(k)
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' }) } catch { f = null }
    _fmts.set(k, f)
  }
  if (!f) return ''
  try {
    return f.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || ''
  } catch {
    return ''
  }
}

/**
 * The zone's short name at that instant: 'EST'/'EDT', 'GMT'/'IST', 'BST',
 * 'GMT+9', or the city.
 * @param {Date|number|string} instant
 * @param {string|null|undefined} zone (invalid → the Dublin floor)
 * @returns {string} '' for an unparseable instant
 */
export function zoneAbbreviation(instant, zone) {
  const d = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(d.getTime())) return ''
  const z = resolveZone(zone)
  let offsetForm = ''
  for (const locale of ABBR_LOCALES) {
    const name = shortName(locale, z, d)
    if (LETTERED.test(name)) return name
    if (!offsetForm && name) offsetForm = name
  }
  return offsetForm || zoneCity(z)
}

/**
 * ' EST' when the record's zone differs from the viewer's, '' otherwise (and ''
 * when the viewer's zone is unknown, or the instant unparseable).
 * @param {Date|number|string} instant
 * @param {string|null|undefined} zone the record's zone
 * @param {string|null|undefined} viewerZone
 */
export function zoneSuffix(instant, zone, viewerZone) {
  if (!needsZoneSuffix(zone, viewerZone)) return ''
  const abbr = zoneAbbreviation(instant, zone)
  return abbr ? ` ${abbr}` : ''
}
