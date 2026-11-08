// HOSTPAGE.2 — GET /api/host/events/[id]/ratings: a host reads the ratings
// of their own event (first names only) with the public summary; another
// host's event is 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let session
let row
let ratings
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { GET } = await import('./route.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const get = () => GET(new Request(`https://crm.test/api/host/events/${E1}/ratings`), { params: Promise.resolve({ id: E1 }) })

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Acme' } }
  row = { id: E1, host_id: 'h1' }
  ratings = [
    { id: 'rt1', rating: 5, comment: 'Loved it', is_public: true, created_at: '2026-07-19T09:00:00Z', contact: { first_name: 'Aoife', email: 'a@x.ie' } },
    { id: 'rt2', rating: 4, comment: null, is_public: true, created_at: '2026-07-19T10:00:00Z', contact: { first_name: 'Dan' } },
    { id: 'rt3', rating: 2, comment: 'Meh', is_public: false, created_at: '2026-07-19T11:00:00Z', contact: null },
    { id: 'rt4', rating: 5, comment: 'Great', is_public: true, created_at: '2026-07-19T12:00:00Z', contact: { first_name: 'Sé' } },
  ]
  db = fakeDb((q) => (q.table === 'race_events' ? { data: row, error: null } : q.table === 'event_ratings' ? { data: ratings, error: null } : { data: null, error: null }))
})

describe('GET /api/host/events/[id]/ratings', () => {
  it('401 without a host session; 404 for another host\'s event', async () => {
    session = null
    expect((await get()).status).toBe(401)
    session = { host: { id: 'h1' } }
    row = { id: E1, host_id: 'h2' }
    expect((await get()).status).toBe(404)
  })
  it('lists every rating (hidden ones included, first names only) with the public summary', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.ratings).toEqual([
      { id: 'rt1', rating: 5, comment: 'Loved it', is_public: true, created_at: '2026-07-19T09:00:00Z', author: 'Aoife' },
      { id: 'rt2', rating: 4, comment: null, is_public: true, created_at: '2026-07-19T10:00:00Z', author: 'Dan' },
      { id: 'rt3', rating: 2, comment: 'Meh', is_public: false, created_at: '2026-07-19T11:00:00Z', author: '' },
      { id: 'rt4', rating: 5, comment: 'Great', is_public: true, created_at: '2026-07-19T12:00:00Z', author: 'Sé' },
    ])
    expect(JSON.stringify(data)).not.toContain('a@x.ie')
    expect(data.summary).toMatchObject({ average: 4.7, count: 3 })
    const q = db.queries.find((x) => x.table === 'event_ratings')
    expect(q.ops).toEqual(expect.arrayContaining([['eq', 'race_event_id', E1]]))
  })
  it('503 when the ratings cannot be read', async () => {
    db = fakeDb((q) => (q.table === 'race_events' ? { data: row, error: null } : { data: null, error: { message: 'boom' } }))
    expect((await get()).status).toBe(503)
  })
})
