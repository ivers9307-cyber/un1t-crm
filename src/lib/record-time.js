// src/lib/record-time.js — TZ.16 (D3 = A). How a staff screen shows a record's
// instant: in the RECORD's studio zone (a 09:00 class in New York reads
// "09:00" to everyone who runs it), with the zone's abbreviation appended ONLY
// when that zone differs from the viewer's ("09:00 EST"). Dublin staff looking
// at Dublin records see exactly the text they saw before: no suffix.
//
// Pure (Intl only, no IO, no logging), so client components import it. Where
// the zones come from:
//   • the record zone: the server resolves it (zoneOfLocation on an embedded
//     `locations(timezone)`, displayZoneFor in src/lib/display-zone.js) and a
//     client component receives it as a prop or in its API payload;
//   • the viewer zone: a client component reads the browser's zone with
//     useViewerZone() (src/lib/use-viewer-zone.js), which is null during the
//     server render so hydration never mismatches; a server page passes
//     viewerZoneOf(user) (the viewer's active studio). Unknown viewer → no
//     suffix, which is today's text.
import { canonicalZone, resolveZone, formatInZone } from '@shared/zoned-time'

/**
 * Should a time in `zone` carry its abbreviation for this viewer?
 * Compared through canonicalZone() (alias spellings agree). An unknown or
 * invalid viewer zone never asks for a suffix.
 * @param {string|null|undefined} zone the record's zone (invalid → the Dublin floor)
 * @param {string|null|undefined} viewerZone
 */
export function needsZoneSuffix(zone, viewerZone) {
  const viewer = canonicalZone(viewerZone)
  if (!viewer) return false
  return resolveZone(zone) !== viewer
}

// The first locale whose short name for the zone is a real abbreviation (EST,
// BST, IST, CEST, AEST) rather than a bare offset; else the offset itself.
// en-US names the Americas, en-GB the UK and central Europe, en-IE Ireland,
// en-AU Australia.
const ABBR_LOCALES = ['en-US', 'en-GB', 'en-IE', 'en-AU']
const BARE_OFFSET = /^(?:GMT|UTC)[+\-−]/
const _abbrFmts = new Map()
function abbrFmt(locale, zone) {
  const k = `${locale}|${zone}`
  let f = _abbrFmts.get(k)
  if (!f) { f = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' }); _abbrFmts.set(k, f) }
  return f
}
const shortName = (locale, zone, d) => abbrFmt(locale, zone).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || ''

/**
 * The zone's short name at that instant ('EST'/'EDT', 'GMT'/'IST', 'GMT+3').
 * @param {Date|number|string} instant
 * @param {string|null|undefined} zone
 * @returns {string} '' for an unparseable instant
 */
export function zoneAbbreviation(instant, zone) {
  const d = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(d.getTime())) return ''
  const z = resolveZone(zone)
  for (const locale of ABBR_LOCALES) {
    const name = shortName(locale, z, d)
    if (name && !BARE_OFFSET.test(name)) return name
  }
  return shortName('en-GB', z, d)
}

/**
 * An instant rendered in the record's zone with the caller's exact Intl
 * options (so Dublin text is unchanged), plus ' <abbr>' when the record zone
 * differs from the viewer's. Never throws: an unparseable instant reads
 * 'Invalid Date' (what Date#toLocaleString printed at these sites), an invalid
 * zone floors to Dublin.
 * @param {Date|number|string} instant
 * @param {string|null|undefined} zone the record's studio zone
 * @param {Intl.DateTimeFormatOptions} [options] the site's own options (no timeZone)
 * @param {string} [locale='en-IE']
 * @param {string|null} [viewerZone=null] the viewer's zone; null = unknown, no suffix
 * @returns {string}
 */
export function formatRecordTime(instant, zone, options = {}, locale = 'en-IE', viewerZone = null) {
  const d = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(d.getTime())) return 'Invalid Date'
  const z = resolveZone(zone)
  const text = formatInZone(d, z, options, locale)
  return needsZoneSuffix(z, viewerZone) ? `${text} ${zoneAbbreviation(d, z)}` : text
}

/**
 * The zone named by its city for staff copy ("Dublin", "New York"), so copy
 * that used to say "Dublin" names the studio's own zone and reads the same for
 * a Dublin studio. Unknown → the Dublin floor.
 * @param {string|null|undefined} zone
 */
export function zoneCity(zone) {
  const z = resolveZone(zone)
  return z.slice(z.lastIndexOf('/') + 1).replace(/_/g, ' ')
}
