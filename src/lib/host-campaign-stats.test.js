// HOST-METRICS.1 — loadHostCampaignStats: the shared lookup for
// host_campaign_stats() (mig 590), used by both the host emails list and
// the per-campaign recipients route. Bigints arrive from PostgREST as
// strings and must be coerced; a stats hiccup must never fail the caller's
// page, so an rpc error surfaces on the return value, not as a throw.

import { describe, it, expect, vi } from 'vitest'
import { loadHostCampaignStats, ZERO_STATS } from './host-campaign-stats.js'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'

function fakeDb(result) {
  const calls = []
  return {
    calls,
    rpc: vi.fn((fn, args) => { calls.push([fn, args]); return Promise.resolve(result) }),
  }
}

describe('loadHostCampaignStats', () => {
  it('coerces bigint strings (PostgREST) to numbers, keyed by campaign_id', async () => {
    const db = fakeDb({
      data: [{
        campaign_id: 'c1', queued: '0', sent: '12', delivered: '10',
        opened: '4', clicked: '1', bounced: '2', complained: '0',
        unsubscribed: '0', failed: '0',
      }],
      error: null,
    })
    const { byCampaign, error } = await loadHostCampaignStats(db, HOST_ID)
    expect(error).toBeNull()
    expect(byCampaign.get('c1')).toEqual({
      queued: 0, sent: 12, delivered: 10, opened: 4, clicked: 1,
      bounced: 2, complained: 0, unsubscribed: 0, failed: 0,
    })
  })

  it('has no entry for a campaign missing from the rpc result — callers fall back to ZERO_STATS', async () => {
    const db = fakeDb({ data: [{ campaign_id: 'c1', queued: '0', sent: '1', delivered: '1', opened: '0', clicked: '0', bounced: '0', complained: '0', unsubscribed: '0', failed: '0' }], error: null })
    const { byCampaign } = await loadHostCampaignStats(db, HOST_ID)
    expect(byCampaign.get('missing-campaign')).toBeUndefined()
    expect(ZERO_STATS).toEqual({
      queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0,
      bounced: 0, complained: 0, unsubscribed: 0, failed: 0,
    })
  })

  it('surfaces an rpc error instead of throwing, with an empty map', async () => {
    const db = fakeDb({ data: null, error: { message: 'rpc broke' } })
    const { byCampaign, error } = await loadHostCampaignStats(db, HOST_ID)
    expect(error).toEqual({ message: 'rpc broke' })
    expect(byCampaign.size).toBe(0)
  })

  it('calls the rpc with the host-scoped arg', async () => {
    const db = fakeDb({ data: [], error: null })
    await loadHostCampaignStats(db, HOST_ID)
    expect(db.rpc).toHaveBeenCalledWith('host_campaign_stats', { p_host_id: HOST_ID })
  })
})
