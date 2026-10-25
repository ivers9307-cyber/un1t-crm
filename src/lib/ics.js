// src/lib/ics.js
// ICSFEED.1 — the smallest correct iCalendar (RFC 5545) writer this repo needs.
//
// Pure: no IO, no clock. Written for SUBSCRIBED calendars (Apple, Google,
// Outlook poll a URL and replace their copy), so there is no METHOD and no
// VTIMEZONE: every time is written in UTC (`…Z`), which RFC 5545 allows
// everywhere and which needs no time-zone rules shipped in the file. Callers
// convert wall clock to UTC first (src/lib/tz-time.js wallMsInTz).
//
// The three rules clients actually enforce:
//   • CRLF line ends, never a bare LF (§3.1);
//   • no line longer than 75 OCTETS — folded with CRLF + one space, and a
//     fold must never split a multi-byte UTF-8 character (§3.1);
//   • TEXT values escape \ ; , and newlines (§3.3.11).

const CRLF = '\r\n'
const MAX_OCTETS = 75
export const MAX_ICS_INTEGER = 2 ** 31 - 1 // RFC 5545 §3.3.8 INTEGER range

function utf8Length(codePoint) {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

// Keep TAB, LF and CR (the newlines are escaped below); drop every other
// control character. Iterated by code point, so no control-character regex.
function stripControls(s) {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0x7f)) out += ch
  }
  return out
}

/** RFC 5545 TEXT escaping. The backslash goes first so no escape is escaped twice. */
export function escapeIcsText(value) {
  if (value == null) return ''
  return stripControls(String(value))
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold one content line to at most 75 octets per physical line. A
 * continuation line starts with one space, which counts toward its 75.
 * Iterates by code point, so a character is never split across a fold.
 */
export function foldIcsLine(line) {
  const parts = []
  let current = ''
  let bytes = 0
  let limit = MAX_OCTETS
  for (const ch of String(line)) {
    const n = utf8Length(ch.codePointAt(0))
    if (bytes + n > limit) {
      parts.push(current)
      current = ''
      bytes = 0
      limit = MAX_OCTETS - 1
    }
    current += ch
    bytes += n
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

/** UTC basic form, e.g. 20260928T050000Z. Throws on a non-finite instant. */
export function formatIcsUtc(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new RangeError('formatIcsUtc: invalid instant')
  }
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/**
 * @param {object} cal
 * @param {string} cal.prodId          PRODID value
 * @param {string} [cal.name]          calendar display name (X-WR-CALNAME + RFC 7986 NAME)
 * @param {number} [cal.refreshMinutes] polling hint (RFC 7986 REFRESH-INTERVAL + X-PUBLISHED-TTL)
 * @param {Array<{uid:string, dtstampMs:number, lastModifiedMs?:number|null, startMs:number,
 *   endMs?:number|null, summary:string, location?:string|null, description?:string|null,
 *   status?:string, sequence?:number}>} cal.events
 * @returns {string} the calendar, CRLF line ends, folded
 */
export function buildIcsCalendar({ prodId, name = null, refreshMinutes = null, events = [] }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN']
  if (name) lines.push(`X-WR-CALNAME:${escapeIcsText(name)}`, `NAME:${escapeIcsText(name)}`)
  if (refreshMinutes) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${refreshMinutes}M`, `X-PUBLISHED-TTL:PT${refreshMinutes}M`)
  }
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${formatIcsUtc(e.dtstampMs)}`)
    // RFC 5545 §3.8.7.4: a revision counter. Outlook only applies an edit to a
    // subscribed event whose SEQUENCE went up. INTEGER is signed 32-bit, so
    // anything that is not a non-negative int in range is left out.
    if (Number.isInteger(e.sequence) && e.sequence >= 0 && e.sequence <= MAX_ICS_INTEGER) {
      lines.push(`SEQUENCE:${e.sequence}`)
    }
    if (e.lastModifiedMs != null) lines.push(`LAST-MODIFIED:${formatIcsUtc(e.lastModifiedMs)}`)
    lines.push(`DTSTART:${formatIcsUtc(e.startMs)}`)
    if (e.endMs != null && e.endMs > e.startMs) lines.push(`DTEND:${formatIcsUtc(e.endMs)}`)
    lines.push(`SUMMARY:${escapeIcsText(e.summary)}`)
    if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`)
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`)
    lines.push(`STATUS:${e.status || 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldIcsLine).join(CRLF) + CRLF
}
