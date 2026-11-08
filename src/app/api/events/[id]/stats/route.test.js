// HOSTSTATS.1 — GET /api/events/[id]/stats: staff (manager+ holding races at
// the event's studio) read an event's signup numbers; outside their studios
// the event is 404, a plain staff member is 403.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-stats', () => ({ loadEventStats: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { loadEventStats } = await import('@/lib/event-stats')
const { GET } = await import('./route.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const L1 = 'a0000000-0000-4000-8000-0000000000a1'
const L2 = 'a0000000-0000-4000-8000-0000000000a2'
const STATS = { views: 3, unique_visitors: 2, registrations: 2, confirmed: 1, conversion_pct: 50, by_source: [], waitlist: { waiting: 0, offered: 0, claimed: 0 }, capped: false }
const user = (locs, role = 'manager') => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races: true } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const get = () => GET(new Request(`https://crm.test/api/events/${E1}/stats`), { params: Promise.resolve({ id: E1 }) })

beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb((q) => (q.table === 'race_events' ? { data: { id: E1, location_id: L1 }, error: null } : { data: null, error: null }))
  loadEventStats.mockResolvedValue({ ok: true, stats: STATS })
})

describe('GET /api/events/[id]/stats', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })
  it('404 when the event sits outside the caller\'s studios', async () => {
    getCurrentUser.mockResolvedValue(user([L2]))
    expect((await get()).status).toBe(404)
    expect(loadEventStats).not.toHaveBeenCalled()
  })
  it('403 for a plain staff member at the studio', async () => {
    getCurrentUser.mockResolvedValue(user([L1], 'staff'))
    expect((await get()).status).toBe(403)
    expect(loadEventStats).not.toHaveBeenCalled()
  })
  it('a manager at the studio reads them', async () => {
    getCurrentUser.mockResolvedValue(user([L1]))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: STATS })
    expect(loadEventStats).toHaveBeenCalledWith(db, E1)
  })
  it('503 when the stats cannot be read', async () => {
    getCurrentUser.mockResolvedValue(user([L1]))
    loadEventStats.mockResolvedValue({ ok: false, error: { message: 'boom' } })
    expect((await get()).status).toBe(503)
  })
})
