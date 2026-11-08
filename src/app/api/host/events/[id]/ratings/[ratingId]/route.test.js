// HOSTPAGE.2 — PATCH /api/host/events/[id]/ratings/[ratingId]: a host hides
// or shows one rating of their own event; a rating on another event is 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let session
let row
let updated
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { PATCH } = await import('./route.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const RT = '90000000-0000-4000-8000-000000000001'
const patch = (body, ratingId = RT) => PATCH(new Request(`https://crm.test/api/host/events/${E1}/ratings/${ratingId}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: E1, ratingId }) })

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1' } }
  row = { id: E1, host_id: 'h1' }
  updated = [{ id: RT }]
  db = fakeDb((q) => (q.table === 'race_events' ? { data: row, error: null } : q.table === 'event_ratings' ? { data: updated, error: null } : { data: null, error: null }))
})

describe('PATCH /api/host/events/[id]/ratings/[ratingId]', () => {
  it('401 without a session; 404 for another host\'s event', async () => {
    session = null
    expect((await patch({ is_public: false })).status).toBe(401)
    session = { host: { id: 'h1' } }
    row = { id: E1, host_id: 'h2' }
    expect((await patch({ is_public: false })).status).toBe(404)
    expect(db.queries.some((q) => q.table === 'event_ratings')).toBe(false)
  })
  it('hides the rating, pinned to the event, and answers the flag', async () => {
    const res = await patch({ is_public: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: RT, is_public: false } })
    const q = db.queries.find((x) => x.table === 'event_ratings' && x.action === 'update')
    expect(q.payload).toEqual({ is_public: false })
    expect(q.ops).toEqual(expect.arrayContaining([['eq', 'id', RT], ['eq', 'race_event_id', E1]]))
  })
  it('404 when the rating is not on this event (zero rows updated); 400 for a bad body', async () => {
    updated = []
    expect((await patch({ is_public: true })).status).toBe(404)
    expect((await patch({ is_public: 'yes' })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
  })
})
