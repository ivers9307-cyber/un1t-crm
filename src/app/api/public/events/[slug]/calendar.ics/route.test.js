// CALENDAR.1 — GET /api/public/events/[slug]/calendar.ics: a published
// event's session as an .ics download; 404 for a draft, a foreign wave, or
// a missing wave on a multi-time event.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let race
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: vi.fn(() => '1.2.3.4'), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://un1t.repset.ie') }))
vi.mock('@/lib/location-branding', () => ({ getLocationOrgBrandName: vi.fn(async () => 'UN1T') }))

const { GET } = await import('./route.js')

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
const W2 = 'f0000000-0000-4000-8000-0000000000f2'
const RACE = {
  id: 'e1', name: 'Mobility Workshop', slug: 'mob', kind: 'workshop', race_date: '2026-07-18', venue_name: null, venue_address: '1 Hatch St',
  active: true, status: 'published', host_id: null, duration_minutes: 90, location_id: 'L1',
  locations: { id: 'L1', name: 'UN1T Hatch Street', address: '1 Hatch St', timezone: 'Europe/Dublin', is_host_anchor: false, organization_id: 'o1' },
  waves: [{ id: W1, start_time: '10:00:00', label: null }],
}
const get = (q = '') => GET(new Request(`https://un1t.repset.ie/api/public/events/mob/calendar.ics${q}`), { params: Promise.resolve({ slug: 'mob' }) })

beforeEach(() => {
  vi.clearAllMocks()
  race = RACE
  db = fakeDb((q) => (q.table === 'race_events' ? { data: race, error: null } : { data: null, error: null }))
})

describe('GET /api/public/events/[slug]/calendar.ics', () => {
  it('answers a text/calendar attachment with the session in UTC', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/calendar/)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="mob.ics"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.text()
    expect(body).toContain('DTSTART:20260718T090000Z')
    expect(body).toContain('DTEND:20260718T103000Z')
    expect(body).toContain('LOCATION:1 Hatch St')
    expect(body).toContain('UID:e1-f0000000-0000-4000-8000-0000000000f1@un1t.repset.ie')
  })
  it('404 for a draft event', async () => {
    race = { ...RACE, status: 'draft' }
    expect((await get()).status).toBe(404)
  })
  it('404 for a wave that is not on the event, and for no wave on a multi-time event', async () => {
    expect((await get('?wave=f0000000-0000-4000-8000-0000000000f9')).status).toBe(404)
    race = { ...RACE, waves: [...RACE.waves, { id: W2, start_time: '14:00:00', label: null }] }
    expect((await get()).status).toBe(404)
    const ok = await get(`?wave=${W2}`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('DTSTART:20260718T130000Z')
  })
  it('a host event never carries the anchor\'s internal label, in LOCATION or the brand lines', async () => {
    const { getLocationOrgBrandName } = await import('@/lib/location-branding')
    getLocationOrgBrandName.mockResolvedValueOnce('Pride Training Club (host events)') // a misconfigured org falls to the location name upstream; the route still must not print it
    race = { ...RACE, name: '', venue_name: null, venue_address: null, host_id: 'h1',
      locations: { id: 'A', name: 'Pride Training Club (host events)', address: null, timezone: 'Europe/Dublin', is_host_anchor: true, organization_id: 'o1' } }
    const body = await (await get()).text()
    expect(body).not.toContain('(host events)')
    expect(body).toContain('SUMMARY:Event')
  })
  it('404 for an unknown slug', async () => {
    db = fakeDb(() => ({ data: null, error: null }))
    expect((await get()).status).toBe(404)
  })
})
