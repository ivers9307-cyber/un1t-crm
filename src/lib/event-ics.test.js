// W1.L5 — the customer's .ics carries the tenant's identity (brand + host),
// never the platform's first gym.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./location-branding.js', () => ({ getLocationBranding: vi.fn() }))
vi.mock('./tenant-host.js', async (importOriginal) => ({ ...(await importOriginal()), resolveCustomerBaseUrl: vi.fn() }))

import { buildEventIcs, eventWallClockMs, resolveEventIcsIdentity } from './event-ics.js'
import { getLocationBranding } from './location-branding.js'
import { resolveCustomerBaseUrl } from './tenant-host.js'

describe('buildEventIcs (W1.L5)', () => {
  it('W1.L5 — the ICS names the tenant, never UN1T', () => {
    const ics = buildEventIcs({ id: 'e1', title: '', startsAt: '2026-11-01T10:00:00Z' }, { brandName: 'Gym A', hostname: 'gym-a.repset.ie' })
    expect(ics).toContain('PRODID:-//Repset//Events//EN')
    expect(ics).toContain('UID:e1@gym-a.repset.ie')
    expect(ics).toContain('SUMMARY:Gym A event')
    expect(ics).not.toContain('UN1T')
  })

  it('emits floating local time (no Z) from the wall-clock instant, 2h default, CRLF lines', () => {
    const ics = buildEventIcs({ id: 'e1', title: 'Hatch 10K', startsAt: '2026-11-01T10:00:00Z' }, { brandName: 'Gym A', hostname: 'gym-a.repset.ie' })
    const lines = ics.split('\r\n')
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines.at(-1)).toBe('END:VCALENDAR')
    expect(lines).toContain('DTSTART:20261101T100000')
    expect(lines).toContain('DTEND:20261101T120000')
    expect(lines).toContain('SUMMARY:Hatch 10K')
    expect(lines.find((l) => l.startsWith('DTSTAMP:'))).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/)
    expect(lines).not.toContain('LOCATION:')
    expect(ics).not.toMatch(/^DESCRIPTION:/m)
  })

  it('escapes commas, semicolons and newlines in text fields; LOCATION and DESCRIPTION only when given', () => {
    const ics = buildEventIcs(
      { id: 'e1', title: 'Run; jump, climb', startsAt: 1_793_527_200_000, location: 'Unit 4, Hatch St', description: 'Team A\nSee you' },
      { brandName: 'Gym A', hostname: 'gym-a.repset.ie' },
    )
    expect(ics).toContain('SUMMARY:Run\\; jump\\, climb')
    expect(ics).toContain('LOCATION:Unit 4\\, Hatch St')
    expect(ics).toContain('DESCRIPTION:Team A\\nSee you')
  })

  it('with no brand at all the fallback summary is "Event", and the host floor is the platform suffix', () => {
    const ics = buildEventIcs({ id: 'e1', title: '', startsAt: '2026-11-01T10:00:00Z' }, { brandName: '', hostname: '' })
    expect(ics).toContain('SUMMARY:Event')
    expect(ics).toContain('UID:e1@repset.ie')
  })

  it('eventWallClockMs composes a Dublin wall-clock date + HH:MM as a UTC-shaped instant (host TZ never leaks)', () => {
    expect(eventWallClockMs('2026-11-01', '10:30')).toBe(Date.UTC(2026, 10, 1, 10, 30))
    expect(eventWallClockMs('2026-11-01T00:00:00+00:00', '09:00:00')).toBe(Date.UTC(2026, 10, 1, 9, 0))
    expect(eventWallClockMs('2026-11-01', null)).toBe(Date.UTC(2026, 10, 1, 9, 0)) // 09:00 default
    expect(eventWallClockMs(null, '10:00')).toBe(null)
  })
})

describe('resolveEventIcsIdentity (W1.L5)', () => {
  const fakeDb = (rows) => ({
    from(table) {
      const filters = []
      const b = {
        select() { return b },
        eq(c, v) { filters.push([c, v]); return b },
        maybeSingle: async () => {
          const hit = (rows[table] || []).find((r) => filters.every(([c, v]) => r[c] === v)) || null
          return { data: hit, error: null }
        },
      }
      return b
    },
  })

  beforeEach(() => { vi.clearAllMocks() })

  it('slug → location → brand name + the tenant hostname (parsed off the customer base URL)', async () => {
    getLocationBranding.mockResolvedValue({ companyName: 'Gym A', shortName: 'Gym A' })
    resolveCustomerBaseUrl.mockResolvedValue('https://gym-a.repset.ie')
    const db = fakeDb({ race_events: [{ id: 'ev1', slug: 'gym-a-nov1-1000', location_id: 'loc-a' }] })
    const out = await resolveEventIcsIdentity(db, 'gym-a-nov1-1000')
    expect(out).toEqual({ brandName: 'Gym A', hostname: 'gym-a.repset.ie' })
    expect(getLocationBranding).toHaveBeenCalledWith(db, 'loc-a')
    expect(resolveCustomerBaseUrl).toHaveBeenCalledWith(db, 'loc-a')
  })

  it('an unknown slug (or no db) answers an empty brand and the platform host floor; never throws', async () => {
    resolveCustomerBaseUrl.mockResolvedValue('https://crm.repset.ie')
    expect(await resolveEventIcsIdentity(fakeDb({ race_events: [] }), 'nope')).toEqual({ brandName: '', hostname: 'crm.repset.ie' })
    expect(getLocationBranding).not.toHaveBeenCalled()
    expect(await resolveEventIcsIdentity(null, 'x')).toEqual({ brandName: '', hostname: 'crm.repset.ie' })
  })

  it('a resolver that throws (unset app URL) still yields a usable identity', async () => {
    getLocationBranding.mockResolvedValue({ companyName: 'Gym A' })
    resolveCustomerBaseUrl.mockRejectedValue(new Error('NEXT_PUBLIC_APP_URL is not set'))
    const db = fakeDb({ race_events: [{ id: 'ev1', slug: 's', location_id: 'loc-a' }] })
    expect(await resolveEventIcsIdentity(db, 's')).toEqual({ brandName: 'Gym A', hostname: 'repset.ie' })
  })
})
