// ICSFEED.1 — the RFC 5545 writer. Every rule here is one a real calendar
// client has been seen to choke on: bare LF line ends, lines over 75 octets,
// a fold that splits a UTF-8 character, an unescaped comma in a LOCATION.

import { describe, it, expect } from 'vitest'
import { escapeIcsText, foldIcsLine, formatIcsUtc, buildIcsCalendar } from './ics'

const octets = (s) => Buffer.byteLength(s, 'utf8')
const unfold = (s) => s.replace(/\r\n /g, '')

describe('escapeIcsText (RFC 5545 §3.3.11)', () => {
  it('escapes backslash, semicolon, comma and every newline form', () => {
    expect(escapeIcsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
    expect(escapeIcsText('x\r\ny\rz')).toBe('x\\ny\\nz')
  })
  it('escapes the backslash FIRST, so an escape is never double-escaped', () => {
    expect(escapeIcsText('\\,')).toBe('\\\\\\,')
  })
  it('drops control characters but keeps a tab', () => {
    expect(escapeIcsText('bell\u0007 tab\t end\u007f')).toBe('bell tab\t end')
  })
  it('null and undefined are empty', () => {
    expect(escapeIcsText(null)).toBe('')
    expect(escapeIcsText(undefined)).toBe('')
  })
})

describe('foldIcsLine (RFC 5545 §3.1)', () => {
  it('leaves a line of 75 octets alone and folds one of 76', () => {
    expect(foldIcsLine('x'.repeat(75))).toBe('x'.repeat(75))
    expect(foldIcsLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`)
  })

  it('no physical line exceeds 75 octets, continuations start with ONE space, and unfolding restores the line', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`
    const physical = foldIcsLine(line).split('\r\n')
    expect(physical[0]).toHaveLength(75)
    for (const p of physical) expect(octets(p)).toBeLessThanOrEqual(75)
    for (const p of physical.slice(1)) expect(p[0]).toBe(' ')
    expect(unfold(foldIcsLine(line))).toBe(line)
  })

  it('never splits a multi-byte character (2-, 3- and 4-byte UTF-8)', () => {
    const line = `SUMMARY:${'é·😀'.repeat(40)}`
    const physical = foldIcsLine(line).split('\r\n')
    expect(physical.length).toBeGreaterThan(1)
    for (const p of physical) {
      expect(octets(p)).toBeLessThanOrEqual(75)
      // A lone surrogate would not survive a UTF-8 round trip.
      expect(Buffer.from(p, 'utf8').toString('utf8')).toBe(p)
    }
    expect(unfold(foldIcsLine(line))).toBe(line)
  })
})

describe('formatIcsUtc', () => {
  it('writes the UTC basic form with a Z', () => {
    expect(formatIcsUtc(Date.UTC(2026, 8, 28, 5, 0, 0))).toBe('20260928T050000Z')
    expect(formatIcsUtc(Date.UTC(2026, 0, 1, 0, 0, 9))).toBe('20260101T000009Z')
  })
  it('throws on a non-finite instant rather than writing 1970', () => {
    expect(() => formatIcsUtc(NaN)).toThrow(RangeError)
    expect(() => formatIcsUtc(null)).toThrow(RangeError)
  })
})

describe('buildIcsCalendar', () => {
  const EVENT = {
    uid: 'shift-a1@repset.ie',
    dtstampMs: Date.UTC(2026, 8, 21, 8, 15),
    lastModifiedMs: Date.UTC(2026, 8, 21, 8, 15),
    startMs: Date.UTC(2026, 8, 28, 5, 0),
    endMs: Date.UTC(2026, 8, 28, 6, 0),
    summary: 'Morning · Studio One',
    location: 'Studio One, 1 Example Street, Dublin',
    description: 'Rostered shift.',
  }

  it('uses CRLF only, begins and ends the calendar, and every line fits 75 octets', () => {
    const out = buildIcsCalendar({ prodId: '-//T//T//EN', name: 'Rostered shifts', refreshMinutes: 60, events: [EVENT] })
    expect(out.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//T//EN\r\n')).toBe(true)
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    for (const line of out.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75)
  })

  it('writes the event with escaped text and UTC times', () => {
    const lines = unfold(buildIcsCalendar({ prodId: '-//T//T//EN', events: [EVENT] })).split('\r\n')
    expect(lines).toEqual(expect.arrayContaining([
      'BEGIN:VEVENT',
      'UID:shift-a1@repset.ie',
      'DTSTAMP:20260921T081500Z',
      'LAST-MODIFIED:20260921T081500Z',
      'DTSTART:20260928T050000Z',
      'DTEND:20260928T060000Z',
      'SUMMARY:Morning · Studio One',
      'LOCATION:Studio One\\, 1 Example Street\\, Dublin',
      'DESCRIPTION:Rostered shift.',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    ]))
  })

  it('asks for hourly refresh when told to, and names the calendar', () => {
    const lines = buildIcsCalendar({ prodId: '-//T//T//EN', name: 'Rostered shifts', refreshMinutes: 60, events: [] }).split('\r\n')
    expect(lines).toEqual(expect.arrayContaining([
      'X-WR-CALNAME:Rostered shifts',
      'NAME:Rostered shifts',
      'REFRESH-INTERVAL;VALUE=DURATION:PT60M',
      'X-PUBLISHED-TTL:PT60M',
    ]))
  })

  it('omits DTEND when the end is not after the start (RFC 5545 §3.6.1: the event ends at DTSTART)', () => {
    const out = buildIcsCalendar({ prodId: '-//T//T//EN', events: [{ ...EVENT, endMs: EVENT.startMs }] })
    expect(out).not.toContain('DTEND')
    const out2 = buildIcsCalendar({ prodId: '-//T//T//EN', events: [{ ...EVENT, endMs: null }] })
    expect(out2).not.toContain('DTEND')
  })

  it('an empty calendar is still a valid calendar', () => {
    expect(buildIcsCalendar({ prodId: '-//T//T//EN', events: [] }))
      .toBe('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//T//EN\r\nCALSCALE:GREGORIAN\r\nEND:VCALENDAR\r\n')
  })
})
