// HOST-METRICS.1 — GET /api/host/emails: the host's own campaigns list with
// per-campaign send stats (host_campaign_stats(), mig 590) attached via
// loadHostCampaignStats. A stats hiccup must never fail the list — but it
// must also never LIE: an rpc error OMITS `stats` entirely (the UI's own
// statsLine fallback returns null when `stats` is absent) rather than
// zeroing it, which would print "0 sent" for a campaign that genuinely
// sent mail. A campaign simply missing from an OK rpc result still gets
// ZERO_STATS — it really has none.
//
// HOST-EMAILS.2 — each row also carries `paused_reason`: a 'sending'
// campaign the queue has halted (sender unverified, or no stream for a
// marketing send) is PAUSED, not "Sending" forever.

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
const HEALTHY_HOST = { sender_domain_verified: true, sender_email: 'news@runners.ie', postmark_stream_id: 'colm-events' }

// ── chainable fake: host_campaigns select().eq().order().limit() resolves
// { data, error }; event_hosts select().eq().maybeSingle() resolves its own.
function makeDb(campaigns, { error = null, hostRow = HEALTHY_HOST, hostErr = null } = {}) {
  const campaignsChain = {
    select: vi.fn(() => campaignsChain),
    eq: vi.fn(() => campaignsChain),
    order: vi.fn(() => campaignsChain),
    limit: vi.fn(() => Promise.resolve({ data: campaigns, error })),
  }
  const hostChain = {
    select: vi.fn(() => hostChain),
    eq: vi.fn(() => hostChain),
    maybeSingle: vi.fn(() => Promise.resolve({ data: hostRow, error: hostErr })),
  }
  return { from: vi.fn((table) => (table === 'event_hosts' ? hostChain : campaignsChain)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
  loadHostCampaignStats.mockResolvedValue({ byCampaign: new Map(), error: null })
})

describe('GET /api/host/emails', () => {
  it('401s without a host session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('omits `stats` on a stats rpc error — never zeroes a real send count', async () => {
    const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', sent_count: 124, status: 'sent' }]
    createServerClient.mockReturnValue(makeDb(campaigns))
    loadHostCampaignStats.mockResolvedValue({ byCampaign: new Map(), error: { message: 'rpc broke' } })

    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data[0]).not.toHaveProperty('stats')
  })

  it('zeroes stats for a campaign missing from an OK rpc result', async () => {
    const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', sent_count: 0, status: 'draft' }]
    createServerClient.mockReturnValue(makeDb(campaigns))

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
    const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', sent_count: 12, status: 'sent' }]
    createServerClient.mockReturnValue(makeDb(campaigns))
    loadHostCampaignStats.mockResolvedValue({ byCampaign: new Map([[CAMPAIGN_ID, stats]]), error: null })

    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data[0].stats).toEqual(stats)
  })

  it('500s with the db message when the campaign read fails', async () => {
    createServerClient.mockReturnValue(makeDb(null, { error: { message: 'kaboom' } }))
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })

  describe('paused_reason (HOST-EMAILS.2)', () => {
    it('is null for a non-sending campaign, even with a blocked host', async () => {
      const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', status: 'draft' }]
      createServerClient.mockReturnValue(makeDb(campaigns, { hostRow: { ...HEALTHY_HOST, sender_domain_verified: false } }))
      const res = await GET()
      const body = await res.json()
      expect(body.data[0].paused_reason).toBeNull()
    })

    it('is null for a sending campaign on a healthy host', async () => {
      const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', status: 'sending', email_type: 'marketing' }]
      createServerClient.mockReturnValue(makeDb(campaigns))
      const res = await GET()
      const body = await res.json()
      expect(body.data[0].paused_reason).toBeNull()
    })

    it('is sender_not_verified for a sending campaign on an unverified host', async () => {
      const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', status: 'sending', email_type: 'marketing' }]
      createServerClient.mockReturnValue(makeDb(campaigns, { hostRow: { ...HEALTHY_HOST, sender_domain_verified: false } }))
      const res = await GET()
      const body = await res.json()
      expect(body.data[0].paused_reason).toBe('sender_not_verified')
    })

    it('is no_stream for a sending marketing campaign with no host stream', async () => {
      const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', status: 'sending', email_type: 'marketing' }]
      createServerClient.mockReturnValue(makeDb(campaigns, { hostRow: { ...HEALTHY_HOST, postmark_stream_id: null } }))
      const res = await GET()
      const body = await res.json()
      expect(body.data[0].paused_reason).toBe('no_stream')
    })

    it('500s with the db message when the host read fails', async () => {
      const campaigns = [{ id: CAMPAIGN_ID, subject: 'Race week', status: 'sending' }]
      createServerClient.mockReturnValue(makeDb(campaigns, { hostErr: { message: 'kaboom' } }))
      const res = await GET()
      expect(res.status).toBe(500)
      expect((await res.json()).error).toBe('kaboom')
    })
  })
})
