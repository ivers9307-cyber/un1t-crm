// CALENDAR.1 — the confirmed page's data carries the entry's calendar links
// (built on the tenant host) or null when the event has no session instant.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let row
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: vi.fn(() => '1.2.3.4'), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://un1t.repset.ie') }))

const { GET } = await import('./route.js')

const R1 = '80000000-0000-4000-8000-000000000001'
const ROW = {
  id: R1, status: 'confirmed', registered_at: '2026-11-15T12:00:00Z', team_composition: 'all_non_members',
  race: { id: 'e1', name: 'Mobility', slug: 'mob', kind: 'workshop', race_date: '2026-07-18', location_id: 'L1', venue_name: null, venue_address: '1 Hatch St', duration_minutes: null,
    locations: { name: 'UN1T Hatch Street', address: '1 Hatch St', timezone: 'Europe/Dublin', is_host_anchor: false } },
  wave: { id: 'w1', start_time: '10:00:00', label: null },
  teams: { id: 't1', name: 'Aoife', size: 1, team_members: [{ id: 'm1', name: 'Aoife', role: 'captain', is_member: false }] },
}
const get = () => GET(new Request(`https://un1t.repset.ie/api/public/event-registrations/${R1}`), { params: Promise.resolve({ id: R1 }) })

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret'
  row = ROW
  db = fakeDb((q) => (q.table === 'race_registrations' ? { data: row, error: null } : { data: null, error: null }))
})

describe('GET /api/public/event-registrations/[id] — calendar', () => {
  it('carries the .ics route link and the Google link for the entry\'s session', async () => {
    const body = await (await get()).json()
    expect(body.data.calendar.ics_url).toBe('https://un1t.repset.ie/api/public/events/mob/calendar.ics?wave=w1')
    expect(body.data.calendar.google_url).toContain('dates=20260718T090000Z%2F20260718T100000Z')
    expect(body.data.calendar.google_url).toContain('location=1+Hatch+St')
  })
  it('hands the page a safe `where` (venue address → venue name → public location), never an anchor label', async () => {
    row = { ...ROW, race: { ...ROW.race, venue_address: null, venue_name: null, locations: { name: 'Pride Training Club (host events)', address: null, timezone: 'Europe/Dublin', is_host_anchor: true } } }
    const body = await (await get()).json()
    expect(body.data.race.where).toBe('')
    expect(JSON.stringify(body)).not.toContain('(host events)')
    row = ROW
    const ok = await (await get()).json()
    expect(ok.data.race.where).toBe('1 Hatch St')
  })
  it('null when the entry has no session time', async () => {
    row = { ...ROW, wave: null, race: { ...ROW.race, waves: undefined } }
    const body = await (await get()).json()
    expect(body.data.calendar).toBeNull()
  })
})
