// src/app/api/home-queue/count/route.test.js
// WIDGET.1 — the What Needs Me widget reads this route.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ user: { id: 'u1' }, locationId: 'loc-1' }))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => Object.assign(
    async (request, ctx) => handler({
      user: h.user, db: {}, locationId: h.locationId, request,
      params: ctx?.params ? await ctx.params : undefined,
    }),
    { _opts: opts }
  ),
}))
vi.mock('@/lib/home-queue', () => ({ getHomeQueueCounts: vi.fn() }))

import { GET } from './route.js'
import { getHomeQueueCounts } from '@/lib/home-queue'

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/home-queue/count', () => {
  it('opts into widget tokens and is location-scoped', () => {
    expect(GET._opts.allowWidgetToken).toBe(true)
    expect(GET._opts.location).toBe(true)
  })

  it('returns count, bySource and degraded', async () => {
    getHomeQueueCounts.mockResolvedValue({
      count: 5, bySource: { approvals: 3, mail: 2, inbox: 0 }, degraded: [],
    })
    const res = await GET(new Request('https://x.test/api/home-queue/count'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { count: 5, bySource: { approvals: 3, mail: 2, inbox: 0 }, degraded: [] },
    })
  })

  it('still answers 500 when mailbox visibility is unavailable', async () => {
    // EMAIL-TICKET-CLEANUP.2 — a bare 0 here would read as "nothing to do"
    // rather than "we could not check". The 500 posture must survive.
    getHomeQueueCounts.mockRejectedValue(new Error('visibility down'))
    const res = await GET(new Request('https://x.test/api/home-queue/count'))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
