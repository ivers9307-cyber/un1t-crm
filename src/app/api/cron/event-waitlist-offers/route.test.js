import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))
vi.mock('@/lib/event-waitlist', () => ({ runWaitlistOffers: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

const { runWaitlistOffers } = await import('@/lib/event-waitlist')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { GET } = await import('./route.js')

const call = (auth) => GET(new Request('https://crm.test/api/cron/event-waitlist-offers', { headers: auth ? { authorization: auth } : {} }))
const COUNTS = { events: 1, offered: 3, expired: 0, skipped: 0, failed: 0, no_room: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'cron-secret'
  runWaitlistOffers.mockResolvedValue(COUNTS)
})

describe('GET /api/cron/event-waitlist-offers', () => {
  it('refuses without the cron bearer', async () => {
    expect((await call()).status).toBe(401)
    expect((await call('Bearer wrong')).status).toBe(401)
    expect(runWaitlistOffers).not.toHaveBeenCalled()
  })

  it('runs the round and stamps the heartbeat with its counts', async () => {
    const res = await call('Bearer cron-secret')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(COUNTS)
    expect(stampHeartbeat).toHaveBeenCalledWith('event-waitlist-offers', COUNTS)
  })

  it('a round that could not read the list is a 500 and no stamp', async () => {
    runWaitlistOffers.mockRejectedValue(new Error('event_waitlist read failed'))
    expect((await call('Bearer cron-secret')).status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
