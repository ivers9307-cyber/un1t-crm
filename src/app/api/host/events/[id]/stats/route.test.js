// HOSTSTATS.1 — GET /api/host/events/[id]/stats: a host reads their own
// event's signup numbers; another host's event is 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let session
let row
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-stats', () => ({ loadEventStats: vi.fn() }))

const { loadEventStats } = await import('@/lib/event-stats')
const { GET } = await import('./route.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const STATS = { views: 3, unique_visitors: 2, registrations: 2, confirmed: 1, conversion_pct: 50, by_source: [], waitlist: { waiting: 0, offered: 0, claimed: 0 }, capped: false }
const get = () => GET(new Request(`https://crm.test/api/host/events/${E1}/stats`), { params: Promise.resolve({ id: E1 }) })

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club' } }
  row = { id: E1, host_id: 'h1' }
  db = fakeDb((q) => (q.table === 'race_events' ? { data: row, error: null } : { data: null, error: null }))
  loadEventStats.mockResolvedValue({ ok: true, stats: STATS })
})

describe('GET /api/host/events/[id]/stats', () => {
  it('401 without a host session', async () => {
    session = null
    expect((await get()).status).toBe(401)
    expect(loadEventStats).not.toHaveBeenCalled()
  })
  it('404 for another host\'s event', async () => {
    row.host_id = 'h2'
    expect((await get()).status).toBe(404)
    expect(loadEventStats).not.toHaveBeenCalled()
  })
  it('answers the stats for the host\'s own event', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: STATS })
    expect(loadEventStats).toHaveBeenCalledWith(db, E1)
  })
  it('503 when the stats cannot be read', async () => {
    loadEventStats.mockResolvedValue({ ok: false, error: { message: 'boom' } })
    expect((await get()).status).toBe(503)
  })
})
