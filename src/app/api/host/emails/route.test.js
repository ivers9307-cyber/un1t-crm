// HOST-METRICS.1 — GET /api/host/emails: the host's own campaigns list with
// per-campaign send stats (host_campaign_stats(), mig 590) attached via
// loadHostCampaignStats. A stats hiccup must never fail the list — but it
// must also never LIE: an rpc error OMITS `stats` entirely (the UI's own
// statsLine fallback returns null when `stats` is absent) rather than
// zeroing it, which would print "0 sent" for a campaign that genuinely
// sent mail. A campaign simply missing from an OK rpc result still gets
// ZERO_STATS — it really has none.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-campaign-stats', () => ({
  loadHostCampaignStats: vi.fn(),
  ZERO_STATS: Object.freeze({
    queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0,
    bounced: 0, complained: 0, unsubscribed: 0, failed: 0,
  }),
}))

import { GET } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostCampaignStats, ZERO_STATS } from '@/lib/host-campaign-stats'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

// ── chainable fake: select().eq().order().limit() resolves { data, error } ──
function makeDb(campaigns, error = null) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    order: vi.fn(() => b),
    limit: vi.fn(() => Promise.resolve({ data: campaigns, error })),
  }
  return { from: vi.fn(() => b) }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('GET /api/host/emails', () => {
  it('401s without a host session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('omits `stats` on a stats rpc error — never zeroes a real send count', async () => {
    const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', sent_count: 124 }]
    createServerClient.mockReturnValue(makeDb(campaigns))
    loadHostCampaignStats.mockResolvedValue({ byCampaign: new Map(), error: { message: 'rpc broke' } })

    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual(campaigns)
    expect(body.data[0]).not.toHaveProperty('stats')
  })

  it('zeroes stats for a campaign missing from an OK rpc result', async () => {
    const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', sent_count: 0 }]
    createServerClient.mockReturnValue(makeDb(campaigns))
    loadHostCampaignStats.mockResolvedValue({ byCampaign: new Map(), error: null })

    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data[0].stats).toEqual(ZERO_STATS)
  })

  it('attaches the real stats row when the rpc has one for this campaign', async () => {
    const stats = {
      queued: 0, sent: 12, delivered: 10, opened: 4, clicked: 1,
      bounced: 2, complained: 0, unsubscribed: 0, failed: 0,
    }
    const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', sent_count: 12 }]
    createServerClient.mockReturnValue(makeDb(campaigns))
    loadHostCampaignStats.mockResolvedValue({ byCampaign: new Map([[CAMPAIGN_ID, stats]]), error: null })

    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data[0].stats).toEqual(stats)
  })
})
