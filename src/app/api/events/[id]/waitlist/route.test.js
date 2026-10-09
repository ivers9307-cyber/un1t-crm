// EVENT-WAITLIST.1 — the staff waitlist routes: list (with the count), remove,
// and "Offer now". Gate: races somewhere (403), the event visible (404),
// races + a manager role at the event's studio (403).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const ROW_ID = 'a0000000-0000-4000-8000-0000000000a1'
let user
let canRaces
let isManager
let visible
let db
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => user),
  assertLocationAccessOr404: vi.fn(() => (visible ? null : new Response('{}', { status: 404 }))),
  hasRoleAtLocation: vi.fn(() => isManager),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => canRaces),
  hasPermissionForLocation: vi.fn(() => canRaces),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
let limitAllowed = true
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => (limitAllowed ? { allowed: true } : { allowed: false, retryAfterSec: 60 })),
  rateLimitResponse: vi.fn((_l, message) => new Response(JSON.stringify({ success: false, error: message }), { status: 429 })),
}))
vi.mock('@/lib/event-waitlist', async (importOriginal) => ({ ...(await importOriginal()), runWaitlistOffers: vi.fn() }))

const { runWaitlistOffers } = await import('@/lib/event-waitlist')
const { GET } = await import('./route.js')
const { DELETE } = await import('./[rowId]/route.js')
const { POST: OFFER } = await import('./offer/route.js')

const RACE = { id: E1, name: 'Hatch Relay', location_id: 'L1', host_id: null }
const ROWS = [
  { id: 'r1', name: 'Ann', email: 'ann@example.test', status: 'waiting' },
  { id: 'r2', name: 'Bo', email: 'bo@example.test', status: 'offered' },
  { id: 'r3', name: 'Cy', email: 'cy@example.test', status: 'removed' },
]
const props = (extra = {}) => ({ params: Promise.resolve({ id: E1, ...extra }) })

function staffDb({ race = RACE, rows = ROWS, removed = [{ id: ROW_ID, status: 'removed', removed_by_name: 'Sam Staff' }] } = {}) {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: race, error: null }
    if (q.table === 'event_waitlist' && q.action === 'update') return { data: removed, error: null }
    if (q.table === 'event_waitlist') return { data: rows, error: null }
    return { data: null, error: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  limitAllowed = true
  user = { id: 'u1', full_name: 'Sam Staff' }
  canRaces = true
  isManager = true
  visible = true
  db = staffDb()
  runWaitlistOffers.mockResolvedValue({ events: 1, offered: 2, expired: 0, skipped: 0, failed: 0, no_room: 0 })
})

describe('GET /api/events/[id]/waitlist', () => {
  it('lists every row of the event, scoped to its studio, with the count still waiting', async () => {
    const res = await GET(new Request('https://crm.test'), props())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3'])
    expect(j.data.waiting).toBe(2)
    const q = db.queries.find((x) => x.table === 'event_waitlist')
    expect(eqOf(q, 'race_event_id')).toBe(E1)
    expect(eqOf(q, 'location_id')).toBe('L1')
  })

  it('401 signed out, 403 without races, 404 an event at a studio the caller cannot see, 403 without a manager role', async () => {
    user = null
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(401)
    user = { id: 'u1' }
    canRaces = false
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(403)
    canRaces = true
    visible = false
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(404)
    visible = true
    isManager = false
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(403)
  })

  it('404 for a missing event or a malformed id', async () => {
    db = staffDb({ race: null })
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(404)
    expect((await GET(new Request('https://crm.test'), { params: Promise.resolve({ id: 'nope' }) })).status).toBe(404)
  })
})

describe('DELETE /api/events/[id]/waitlist/[rowId]', () => {
  it('marks the row removed on THIS event, naming who did it', async () => {
    const res = await DELETE(new Request('https://crm.test', { method: 'DELETE' }), props({ rowId: ROW_ID }))
    expect(res.status).toBe(200)
    const q = db.queries.find((x) => x.table === 'event_waitlist' && x.action === 'update')
    expect(q.payload).toEqual({ status: 'removed', removed_by_name: 'Sam Staff' })
    expect(eqOf(q, 'id')).toBe(ROW_ID)
    expect(eqOf(q, 'race_event_id')).toBe(E1)
    expect(eqOf(q, 'location_id')).toBe('L1')
  })

  it('names the master under impersonation', async () => {
    user = { id: 'u1', full_name: 'Sam Staff', impersonatingFrom: { masterId: 'm1', masterName: 'Rich' } }
    await DELETE(new Request('https://crm.test', { method: 'DELETE' }), props({ rowId: ROW_ID }))
    expect(db.queries.find((x) => x.action === 'update').payload.removed_by_name).toBe('Rich as Sam Staff')
  })

  it('404 for a row that is not on this event', async () => {
    db = staffDb({ removed: [] })
    expect((await DELETE(new Request('https://crm.test', { method: 'DELETE' }), props({ rowId: ROW_ID }))).status).toBe(404)
  })

  it('a manager role is required', async () => {
    isManager = false
    expect((await DELETE(new Request('https://crm.test', { method: 'DELETE' }), props({ rowId: ROW_ID }))).status).toBe(403)
    expect(db.queries.some((x) => x.action === 'update')).toBe(false)
  })
})

describe('POST /api/events/[id]/waitlist/offer', () => {
  it('runs the round for this event only and answers its counts', async () => {
    const res = await OFFER(new Request('https://crm.test', { method: 'POST' }), props())
    expect(res.status).toBe(200)
    expect(runWaitlistOffers).toHaveBeenCalledWith(db, { eventId: E1, force: true })
    expect((await res.json()).data.offered).toBe(2)
  })

  it('a round that cannot read the list is a 500', async () => {
    runWaitlistOffers.mockRejectedValue(new Error('down'))
    expect((await OFFER(new Request('https://crm.test', { method: 'POST' }), props())).status).toBe(500)
  })

  it('gated like the list', async () => {
    canRaces = false
    expect((await OFFER(new Request('https://crm.test', { method: 'POST' }), props())).status).toBe(403)
    expect(runWaitlistOffers).not.toHaveBeenCalled()
  })
})

describe('Offer now throttle', () => {
  it('over 3 an hour per event: 429 with a plain message, no round', async () => {
    limitAllowed = false
    const res = await OFFER(new Request('https://crm.test', { method: 'POST' }), props())
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('Offer now can run 3 times an hour for an event. Try again later.')
    expect(runWaitlistOffers).not.toHaveBeenCalled()
  })
})
