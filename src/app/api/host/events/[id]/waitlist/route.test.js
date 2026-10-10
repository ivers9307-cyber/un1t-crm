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
let limitAllowed = true
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => (limitAllowed ? { allowed: true } : { allowed: false, retryAfterSec: 60 })),
  rateLimitResponse: vi.fn((_l, message) => new Response(JSON.stringify({ success: false, error: message }), { status: 429 })),
}))
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
  limitAllowed = true
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
    expect(runWaitlistOffers).toHaveBeenCalledWith(db, { eventId: E1, force: true })
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

describe('Offer now throttle', () => {
  it('over 3 an hour per event: 429 with a plain message, no round', async () => {
    limitAllowed = false
    const res = await OFFER(new Request('https://crm.test', { method: 'POST' }), props())
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('Offer now can run 3 times an hour for an event. Try again later.')
    expect(runWaitlistOffers).not.toHaveBeenCalled()
  })
})
