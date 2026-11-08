// HOSTSERIES.1 — POST /api/events/[id]/duplicate: staff copy an event to a
// new date. Manager+ holding `races` at the event's studio; 404 outside the
// caller's studios, 403 for a plain member there.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const L1 = 'a0000000-0000-4000-8000-0000000000a1'
const L2 = 'a0000000-0000-4000-8000-0000000000a2'
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-duplicate', async (importOriginal) => ({ ...(await importOriginal()), duplicateEvent: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { duplicateEvent } = await import('@/lib/event-duplicate')
const { POST } = await import('./route.js')

const user = (locs, role = 'manager') => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races: true } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const props = () => ({ params: Promise.resolve({ id: E1 }) })
const post = (body) => POST(new Request(`https://crm.test/api/events/${E1}/duplicate`, { method: 'POST', body: JSON.stringify(body) }), props())

beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb((q) => (q.table === 'race_events' ? { data: { id: E1, location_id: L1 }, error: null } : { data: null, error: null }))
  duplicateEvent.mockResolvedValue({ ok: true, event: { id: 'E-new', slug: 'hatch-dec12-1000' } })
})

describe('POST /api/events/[id]/duplicate', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ race_date: '2026-12-12' })).status).toBe(401)
  })
  it('404 when the event sits outside the caller\'s studios', async () => {
    getCurrentUser.mockResolvedValue(user([L2]))
    expect((await post({ race_date: '2026-12-12' })).status).toBe(404)
    expect(duplicateEvent).not.toHaveBeenCalled()
  })
  it('403 for a plain staff member at the studio', async () => {
    getCurrentUser.mockResolvedValue(user([L1], 'staff'))
    expect((await post({ race_date: '2026-12-12' })).status).toBe(403)
    expect(duplicateEvent).not.toHaveBeenCalled()
  })
  it('a manager at the studio copies it', async () => {
    getCurrentUser.mockResolvedValue(user([L1]))
    const res = await post({ race_date: '2026-12-12' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: 'E-new', slug: 'hatch-dec12-1000' } })
    expect(duplicateEvent).toHaveBeenCalledWith(db, { sourceId: E1, raceDate: '2026-12-12' })
  })
  it('400 for a bad date', async () => {
    getCurrentUser.mockResolvedValue(user([L1]))
    expect((await post({ race_date: 'tomorrow' })).status).toBe(400)
  })
})
