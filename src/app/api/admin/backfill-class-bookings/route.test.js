// W1.M3b — the route read missingGlofoxCredentialsForLocation (an ARRAY) as a
// boolean, so it answered 400 "not connected" for every location, connected or
// not, since HR-CLASS-ALLOC.2. Pins: connected → runs; missing → 400 naming
// what is missing; an unreadable settings row → 503 (REGISTRYREAD.1b).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(),
  fetchUserBookings: vi.fn(async () => []),
}))
vi.mock('@/lib/class-bookings', () => ({ upsertClassBookings: vi.fn(async () => ({ upserted: 2 })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { glofoxCredentialsForLocation, fetchUserBookings } = await import('@/lib/glofox')
const { fakeDb } = await import('@/lib/time-off.test-helpers')
const { POST } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const req = () => new Request(`http://test/api/admin/backfill-class-bookings?location_id=${LOC}`, { method: 'POST' })
const FULL = { branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'm', role: 'master' })
  createServerClient.mockReturnValue(fakeDb((q) => (q.table === 'contacts'
    ? { data: [{ id: 'c1', glofox_member_id: '64aa000000000000000000aa', first_name: 'A', last_name: 'B', name: null }], error: null }
    : { data: [], error: null })))
})

describe('POST /api/admin/backfill-class-bookings — the credentials check (W1.M3b)', () => {
  it('a connected location runs the backfill (used to 400 on every call)', async () => {
    glofoxCredentialsForLocation.mockResolvedValue(FULL)
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, members: 1, upserted: 2 })
    expect(fetchUserBookings).toHaveBeenCalledTimes(1)
  })
  it('missing credentials → 400 naming what is missing, no Glofox call', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: null, apiToken: null, readError: null })
    const res = await POST(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/missing: API Key, API Token/)
    expect(fetchUserBookings).not.toHaveBeenCalled()
  })
  it('an unreadable settings row → 503, never "not connected"', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const res = await POST(req())
    expect(res.status).toBe(503)
    expect(fetchUserBookings).not.toHaveBeenCalled()
  })
  it('a non-master is refused', async () => {
    getCurrentUser.mockResolvedValue({ id: 'o', role: 'owner' })
    expect((await POST(req())).status).toBe(403)
  })
})
