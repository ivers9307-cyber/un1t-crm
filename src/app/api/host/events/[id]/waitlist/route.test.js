// EVENT-WAITLIST.1 — the host waitlist routes: list and "Offer now", own
// events only (404 otherwise).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
let session
let db
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-waitlist', async (importOriginal) => ({ ...(await importOriginal()), runWaitlistOffers: vi.fn() }))

const { runWaitlistOffers } = await import('@/lib/event-waitlist')
const { GET } = await import('./route.js')
const { POST: OFFER } = await import('./offer/route.js')

const props = () => ({ params: Promise.resolve({ id: E1 }) })
const hostDb = (race) => fakeDb((q) => {
  if (q.table === 'race_events') return { data: race, error: null }
  if (q.table === 'event_waitlist') return { data: [{ id: 'r1', status: 'waiting' }, { id: 'r2', status: 'claimed' }], error: null }
  return { data: null, error: null }
})

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club' } }
  db = hostDb({ id: E1, location_id: 'L-anchor', host_id: 'h1' })
  runWaitlistOffers.mockResolvedValue({ events: 1, offered: 1, expired: 0, skipped: 0, failed: 0, no_room: 0 })
})

describe('host waitlist routes', () => {
  it('lists the rows of the host\'s own event with the count still waiting', async () => {
    const res = await GET(new Request('https://crm.test'), props())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.waiting).toBe(1)
    expect(j.data.rows).toHaveLength(2)
  })

  it('offers now for the host\'s own event', async () => {
    const res = await OFFER(new Request('https://crm.test', { method: 'POST' }), props())
    expect(res.status).toBe(200)
    expect(runWaitlistOffers).toHaveBeenCalledWith(db, { eventId: E1 })
  })

  it('401 without a host session; 404 for another host\'s event, both routes', async () => {
    session = null
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(401)
    session = { host: { id: 'h2' } }
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(404)
    expect((await OFFER(new Request('https://crm.test', { method: 'POST' }), props())).status).toBe(404)
    expect(runWaitlistOffers).not.toHaveBeenCalled()
  })
})
