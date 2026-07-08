// EVENTS-REMINDERS.1 — pure-helper tests for the standalone events-platform
// pre-event reminders (race_events / race_registrations). Exercises the two
// exported pure helpers directly; the DB orchestration (runEventReminders) is
// integration-shaped and not covered here.
//
// Runs under TZ=Europe/Dublin in CI (vitest inherits the env). reminderOffset-
// ForDate does its arithmetic on YYYY-MM-DD strings via addDaysISO, which is
// UTC-internally so it is TZ-immune — but we still assert across a Dublin DST
// boundary + a month/year boundary to lock that in.

import { describe, it, expect } from 'vitest'
import { reminderOffsetForDate, buildReminderEmailHtml } from './event-reminders'

describe('reminderOffsetForDate', () => {
  it("returns '3d' when the race is exactly three days out", () => {
    expect(reminderOffsetForDate('2026-07-11', '2026-07-08')).toBe('3d')
  })

  it("returns '1d' when the race is exactly one day out", () => {
    expect(reminderOffsetForDate('2026-07-09', '2026-07-08')).toBe('1d')
  })

  it('returns null two days out (not a reminder day)', () => {
    expect(reminderOffsetForDate('2026-07-10', '2026-07-08')).toBeNull()
  })

  it('returns null on the day of the event', () => {
    expect(reminderOffsetForDate('2026-07-08', '2026-07-08')).toBeNull()
  })

  it('returns null for a past event date', () => {
    expect(reminderOffsetForDate('2026-07-07', '2026-07-08')).toBeNull()
  })

  it('returns null four or more days out', () => {
    expect(reminderOffsetForDate('2026-07-12', '2026-07-08')).toBeNull()
  })

  it('crosses a month boundary correctly (+3d over end of month)', () => {
    // 29 Jul + 3 = 1 Aug
    expect(reminderOffsetForDate('2026-08-01', '2026-07-29')).toBe('3d')
    // 31 Jul + 1 = 1 Aug
    expect(reminderOffsetForDate('2026-08-01', '2026-07-31')).toBe('1d')
  })

  it('is DST-immune across the Dublin spring-forward (late March)', () => {
    // Clocks go forward 01:00→02:00 on 2026-03-29; naive local Date math would
    // drop/duplicate an hour. +1d and +3d must still land on the right dates.
    expect(reminderOffsetForDate('2026-03-29', '2026-03-28')).toBe('1d')
    expect(reminderOffsetForDate('2026-03-31', '2026-03-28')).toBe('3d')
  })

  it('crosses a year boundary correctly', () => {
    expect(reminderOffsetForDate('2027-01-01', '2026-12-29')).toBe('3d')
    expect(reminderOffsetForDate('2027-01-01', '2026-12-31')).toBe('1d')
  })

  it('returns null for missing / non-string inputs', () => {
    expect(reminderOffsetForDate(null, '2026-07-08')).toBeNull()
    expect(reminderOffsetForDate('2026-07-11', null)).toBeNull()
    expect(reminderOffsetForDate(undefined, undefined)).toBeNull()
    expect(reminderOffsetForDate('', '')).toBeNull()
    expect(reminderOffsetForDate(20260711, 20260708)).toBeNull()
  })
})

describe('buildReminderEmailHtml', () => {
  const members = [
    { name: 'Alice Captain', qrSrc: 'https://crm.example/api/public/events/checkin-qr?t=TOKEN_A' },
    { name: 'Bob Member', qrSrc: 'https://crm.example/api/public/events/checkin-qr?t=TOKEN_B' },
  ]

  it('renders the event name, when label and location', () => {
    const html = buildReminderEmailHtml({
      eventName: 'Summer Hyrox Sim',
      whenLabel: 'Saturday, 11 July 2026 · 09:30',
      locationName: 'UN1T Stillorgan',
      members,
    })
    expect(html).toContain('Summer Hyrox Sim')
    expect(html).toContain('Saturday, 11 July 2026 · 09:30')
    expect(html).toContain('UN1T Stillorgan')
  })

  it("embeds every member's QR image source", () => {
    const html = buildReminderEmailHtml({
      eventName: 'Summer Hyrox Sim',
      whenLabel: '11 July',
      locationName: 'Stillorgan',
      members,
    })
    expect(html).toContain('TOKEN_A')
    expect(html).toContain('TOKEN_B')
    expect(html).toContain('Alice Captain')
    expect(html).toContain('Bob Member')
    // Two <img> QR tags — one per member.
    expect(html.match(/<img /g)).toHaveLength(2)
  })

  it('HTML-escapes the event name (no raw injection)', () => {
    const html = buildReminderEmailHtml({
      eventName: '<script>alert("x")</script> & friends',
      whenLabel: 'soon',
      locationName: 'Stillorgan',
      members: [],
    })
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp; friends')
  })

  it('escapes member names too', () => {
    const html = buildReminderEmailHtml({
      eventName: 'Event',
      whenLabel: 'soon',
      locationName: 'Loc',
      members: [{ name: '<b>Mallory</b>', qrSrc: 'https://x/qr?t=Z' }],
    })
    expect(html).not.toContain('<b>Mallory</b>')
    expect(html).toContain('&lt;b&gt;Mallory')
  })

  it('omits the check-in section when no member has a QR', () => {
    const html = buildReminderEmailHtml({
      eventName: 'Event',
      whenLabel: 'soon',
      locationName: 'Loc',
      members: [{ name: 'No QR', qrSrc: '' }],
    })
    expect(html).not.toContain('Check-in codes')
    expect(html).not.toContain('<img ')
  })

  it('tolerates missing/empty args without throwing', () => {
    expect(() => buildReminderEmailHtml()).not.toThrow()
    expect(() => buildReminderEmailHtml({})).not.toThrow()
    expect(buildReminderEmailHtml({}).length).toBeGreaterThan(0)
  })
})
