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
//
// The suffix rule itself (needsZoneSuffix, zoneAbbreviation, zoneCity, and the
// sameZone/zoneSuffix helpers) lives in shared/zone-suffix.js, the ONE
// implementation the phone's mobile/lib/studio-zone.js wraps too; this module
// re-exports it (tests/shared-pair-sync.test.js holds it to runtime identity)
// and keeps only the web's formatter.
import { resolveZone, formatInZone } from '@shared/zoned-time'
import { zoneSuffix } from '@shared/zone-suffix'

export { needsZoneSuffix, sameZone, zoneAbbreviation, zoneCity, zoneSuffix } from '@shared/zone-suffix'

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
  return text + zoneSuffix(d, z, viewerZone)
}
