// TZ.12 — the wall clocks the studio TV boards and the coach live board draw,
// in the board's studio zone (locations.timezone), not the screen's own clock
// zone or a hard-coded Dublin.
//
// The live HR board, the challenge board and the cast board's idle screen all
// drew `new Date()` through the HOST's zone (toLocaleTimeString / getHours),
// i.e. whatever zone the kiosk Pi or cast stick was set to. Each board's
// payload now carries its location's zone, and the clocks format through it.
// Until the first payload lands there is no zone yet, and the board keeps the
// screen's own clock exactly as before rather than guessing a zone, so a board
// never blanks and a Dublin board on a Dublin screen is byte-identical
// (src/lib/tz-12.clocks.tz.test.js).
//
// Client-imported, so the zone maths come from @shared/zoned-time.

import { DEFAULT_TZ, canonicalZone, formatInZone, instantToZonedParts } from '@shared/zoned-time'

/**
 * The board's zone from a payload value: the canonical IANA name, or null when
 * the payload has not landed yet or names no valid zone (the servers always
 * send a resolved one).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function boardZone(raw) {
  return canonicalZone(raw)
}

/**
 * Header clock text, e.g. the live board's 'HH:MM:SS'. `options` are the
 * Intl time options the board always used; locale 'en-IE' as before.
 * @param {Date} now
 * @param {string|null} zone  boardZone(); null → the screen's own clock
 * @param {Intl.DateTimeFormatOptions} options
 */
export function boardClockText(now, zone, options) {
  return zone ? formatInZone(now, zone, options, 'en-IE') : now.toLocaleTimeString('en-IE', options)
}

const IDLE_DAY_OPTIONS = { weekday: 'long', day: 'numeric', month: 'long' }
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * The cast board's idle clock: hour, minute and the day line ("today").
 * @param {Date|null} now  null before the screen has mounted (TZ.17: the
 *   server never renders a clock) → all three empty
 * @param {string|null} zone  boardZone(); null → the screen's own clock
 * @returns {{ hh: string, mm: string, day: string }}
 */
export function idleBoardClock(now, zone) {
  if (!now) return { hh: '', mm: '', day: '' }
  if (!zone) {
    return { hh: pad2(now.getHours()), mm: pad2(now.getMinutes()), day: now.toLocaleDateString('en-IE', IDLE_DAY_OPTIONS) }
  }
  const p = instantToZonedParts(now, zone)
  return { hh: pad2(p.h), mm: pad2(p.mi), day: formatInZone(now, zone, IDLE_DAY_OPTIONS, 'en-IE') }
}

const VISIT_OPTIONS = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }

/**
 * The coach live board's Detected-tab visit time ('Sat 11 Oct, 18:00') in the
 * studio's zone. Empty for no value; an unparseable value is shown raw.
 * @param {string|null|undefined} iso
 * @param {string} [zone]  the location's IANA zone
 */
export function visitTimeLabel(iso, zone = DEFAULT_TZ) {
  if (!iso) return ''
  try {
    return formatInZone(new Date(iso), zone, VISIT_OPTIONS, 'en-IE')
  } catch { return iso }
}
