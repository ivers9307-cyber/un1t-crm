// CALENDAR.1 — the calendar links: the studio's wall clock becomes the right
// UTC instant (Dublin in July is UTC+1, New York in January UTC-5), the
// location never names a host anchor, no wave means no link, the .ics is a
// well-formed RFC 5545 file.
import { describe, it, expect } from 'vitest'
import {
  eventDurationMinutes, eventInstant, eventLocationText, eventCalendarLinks, buildEventCalendarIcs,
} from './event-calendar-links.js'

const dublin = { id: 'L1', name: 'UN1T Hatch Street', address: '1 Hatch St, Dublin 2', timezone: 'Europe/Dublin', is_host_anchor: false }
const event = { id: 'e1', name: 'Mobility Workshop', slug: 'mob', kind: 'workshop', race_date: '2026-07-18', venue_name: null, venue_address: null, duration_minutes: null, locations: dublin }
const wave = { id: 'w1', start_time: '10:00:00', label: null }

describe('eventDurationMinutes', () => {
  it('uses the column, else 120 for a race and 60 otherwise', () => {
    expect(eventDurationMinutes({ kind: 'workshop', duration_minutes: 45 })).toBe(45)
    expect(eventDurationMinutes({ kind: 'race', duration_minutes: null })).toBe(120)
    expect(eventDurationMinutes({ kind: 'workshop' })).toBe(60)
    expect(eventDurationMinutes({ duration_minutes: null })).toBe(120) // a missing kind reads as race, as elsewhere
  })
})

describe('eventInstant', () => {
  it('a Dublin July event lands one hour behind its wall clock in UTC', () => {
    const r = eventInstant({ race_date: '2026-07-18', start_time: '10:00:00', zone: 'Europe/Dublin', durationMinutes: 60 })
    expect(new Date(r.startMs).toISOString()).toBe('2026-07-18T09:00:00.000Z')
    expect(new Date(r.endMs).toISOString()).toBe('2026-07-18T10:00:00.000Z')
  })
  it('a New York January event lands five hours ahead', () => {
    const r = eventInstant({ race_date: '2027-01-09', start_time: '18:30', zone: 'America/New_York', durationMinutes: 90 })
    expect(new Date(r.startMs).toISOString()).toBe('2027-01-09T23:30:00.000Z')
    expect(new Date(r.endMs).toISOString()).toBe('2027-01-10T01:00:00.000Z')
  })
  it('no date or no time → null', () => {
    expect(eventInstant({ race_date: null, start_time: '10:00', zone: 'Europe/Dublin', durationMinutes: 60 })).toBeNull()
    expect(eventInstant({ race_date: '2026-07-18', start_time: null, zone: 'Europe/Dublin', durationMinutes: 60 })).toBeNull()
  })
})

describe('eventLocationText', () => {
  it('prefers the venue address, then the venue name, then the public location name', () => {
    expect(eventLocationText({ ...event, venue_address: '2 Somewhere Rd', venue_name: 'The Hall' })).toBe('2 Somewhere Rd')
    expect(eventLocationText({ ...event, venue_name: 'The Hall' })).toBe('The Hall')
    expect(eventLocationText(event)).toBe('UN1T Hatch Street')
  })
  it('never names a host anchor', () => {
    const anchored = { ...event, locations: { id: 'A', name: 'Pride Training Club (host events)', address: null, timezone: 'Europe/Dublin', is_host_anchor: true } }
    expect(eventLocationText(anchored)).not.toMatch(/host events/)
  })
})

describe('eventCalendarLinks', () => {
  it('builds the .ics route link and a Google template link with UTC dates', () => {
    const links = eventCalendarLinks({ event, wave, zone: 'Europe/Dublin', baseUrl: 'https://un1t.repset.ie' })
    expect(links.ics_url).toBe('https://un1t.repset.ie/api/public/events/mob/calendar.ics?wave=w1')
    const u = new URL(links.google_url)
    expect(u.hostname).toBe('calendar.google.com')
    expect(u.searchParams.get('action')).toBe('TEMPLATE')
    expect(u.searchParams.get('text')).toBe('Mobility Workshop')
    expect(u.searchParams.get('dates')).toBe('20260718T090000Z/20260718T100000Z')
    expect(u.searchParams.get('location')).toBe('UN1T Hatch Street')
    expect(u.searchParams.get('details')).toBe('https://un1t.repset.ie/event/mob')
    expect(links.starts_at).toBe('2026-07-18T09:00:00.000Z')
  })
  it('no wave → null; a single-time event without a wave given uses its one time and omits ?wave', () => {
    expect(eventCalendarLinks({ event: { ...event, waves: [] }, wave: null, zone: 'Europe/Dublin', baseUrl: 'https://x' })).toBeNull()
    const single = eventCalendarLinks({ event: { ...event, waves: [wave] }, wave: null, zone: 'Europe/Dublin', baseUrl: 'https://x' })
    expect(single.ics_url).toBe('https://x/api/public/events/mob/calendar.ics')
  })
})

describe('buildEventCalendarIcs', () => {
  it('is an RFC 5545 file with CRLF lines, a UTC DTSTART, the tenant UID and the venue', () => {
    const ics = buildEventCalendarIcs({ event, wave, zone: 'Europe/Dublin', hostname: 'un1t.repset.ie', brandName: 'UN1T' })
    expect(ics).toContain('BEGIN:VCALENDAR\r\n')
    expect(ics).toContain('DTSTART:20260718T090000Z')
    expect(ics).toContain('DTEND:20260718T100000Z')
    expect(ics).toContain('UID:e1-w1@un1t.repset.ie')
    expect(ics).toContain('SUMMARY:Mobility Workshop')
    expect(ics).toContain('LOCATION:UN1T Hatch Street')
    expect(ics).toContain('DESCRIPTION:Booked at UN1T')
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true)
  })
  it('null when the event has no instant', () => {
    expect(buildEventCalendarIcs({ event: { ...event, race_date: null }, wave, zone: 'Europe/Dublin', hostname: 'x', brandName: '' })).toBeNull()
  })
})
