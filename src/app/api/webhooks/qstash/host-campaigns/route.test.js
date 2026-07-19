// QSTASH.8 — response + chaining semantics of the QStash host-campaigns
// worker route.
//
// This is the first BULK worker: one delivery = one ≤50-row chunk of a
// campaign, and while pending rows remain the worker SELF-CHAINS by
// publishing the next kick { campaignId, link+1 } with a 2s delay and —
// deliberately — NO dedup id: each chain link is a distinct message, and
// a dedup id would be swallowed inside QStash's dedup window because the
// body is otherwise identical. The chain is bounded by MAX_CHAIN links
// per delivery lineage; past the cap (and on any chain-publish failure)
// the sweeper cron drains the remainder — the queue table stays the
// delivery guarantee.
//
// Status contract: chunk_sent / drained / halted / skipped → 200
// (halted = kill switch; the campaign stays 'sending' and resumes via
// the cron when re-verified — a QStash retry cannot help); failed
// (infra) → 500 so QStash retries — retry-safe because a crashed
// attempt's claimed rows are never re-sent (cron sweeps them terminal).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/qstash', () => ({
  verifyQStashSignature: vi.fn(() => ({ ok: true, matched: 'current' })),
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-chain' }),
  HOST_CAMPAIGNS_WORKER_PATH: '/api/webhooks/qstash/host-campaigns',
}))
vi.mock('@/lib/host-campaign-queue', () => ({
  processHostCampaignChunk: vi.fn(),
}))

import { POST, statusForVerifyFailure, responseForOutcome, shouldChain, maxDuration, MAX_CHAIN, CHAIN_DELAY_SECONDS } from './route'
import { verifyQStashSignature, publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'
import { processHostCampaignChunk } from '@/lib/host-campaign-queue'

const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000c1'

function makeRequest(body) {
  return new Request('http://localhost/api/webhooks/qstash/host-campaigns', {
    method: 'POST',
    headers: { 'Upstash-Signature': 'sig' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyQStashSignature.mockReturnValue({ ok: true, matched: 'current' })
  publishQueuePush.mockResolvedValue({ ok: true, messageId: 'msg-chain' })
})

describe('constants', () => {
  it('gets the same 300s budget as the cron — a 50-row Postmark chunk can crawl', () => {
    expect(maxDuration).toBe(300)
  })

  it('caps a delivery lineage at 40 links (40 × 50 rows) before the cron takes over', () => {
    expect(MAX_CHAIN).toBe(40)
  })

  it('paces chain links 2s apart', () => {
    expect(CHAIN_DELAY_SECONDS).toBe(2)
  })
})

describe('statusForVerifyFailure', () => {
  it('maps missing_keys to 503 (server misconfig, not caller failure)', () => {
    expect(statusForVerifyFailure('missing_keys')).toBe(503)
  })

  it.each(['missing_signature', 'malformed', 'bad_signature', 'expired', 'not_yet_valid', 'body_mismatch', 'url_mismatch'])(
    'maps %s to 401',
    (reason) => {
      expect(statusForVerifyFailure(reason)).toBe(401)
    },
  )
})

describe('shouldChain', () => {
  it('chains a chunk_sent with pending rows remaining', () => {
    expect(shouldChain({ status: 'chunk_sent', remaining: 12 }, 1)).toBe(true)
  })

  it('does not chain when nothing is pending (in-flight claims finalise elsewhere; cron covers)', () => {
    expect(shouldChain({ status: 'chunk_sent', remaining: 0 }, 1)).toBe(false)
  })

  it('stops at the MAX_CHAIN cap — the cron takes over', () => {
    expect(shouldChain({ status: 'chunk_sent', remaining: 12 }, MAX_CHAIN - 1)).toBe(true)
    expect(shouldChain({ status: 'chunk_sent', remaining: 12 }, MAX_CHAIN)).toBe(false)
  })

  it.each(['drained', 'halted', 'skipped', 'failed'])('never chains a %s outcome', (status) => {
    expect(shouldChain({ status, remaining: 12 }, 1)).toBe(false)
  })
})

describe('responseForOutcome', () => {
  it('chunk_sent → 200 carrying remaining + whether we chained', () => {
    expect(responseForOutcome({ status: 'chunk_sent', remaining: 7 }, { chained: true })).toEqual({
      status: 200,
      body: { success: true, chunk_sent: true, remaining: 7, chained: true },
    })
  })

  it('drained → 200', () => {
    expect(responseForOutcome({ status: 'drained' })).toEqual({
      status: 200,
      body: { success: true, drained: true },
    })
  })

  it('halted → 200 — the campaign resumes via the cron sweeper when re-verified, a retry cannot help', () => {
    expect(responseForOutcome({ status: 'halted' })).toEqual({
      status: 200,
      body: { success: true, halted: true },
    })
  })

  it('skipped → 200 so QStash does not redeliver a finalised campaign', () => {
    expect(responseForOutcome({ status: 'skipped' })).toEqual({
      status: 200,
      body: { success: true, skipped: true },
    })
  })

  it('failed (infra) → 500 — QStash retries; claimed rows are never re-sent', () => {
    expect(responseForOutcome({ status: 'failed', error: 'campaign load failed: boom' })).toEqual({
      status: 500,
      body: { success: false, error: 'campaign load failed: boom' },
    })
  })

  it('failed with no error string → generic processing_failed', () => {
    expect(responseForOutcome({ status: 'failed' })).toEqual({
      status: 500,
      body: { success: false, error: 'processing_failed' },
    })
  })
})

describe('POST — verification and body parsing', () => {
  it('rejects a bad signature with 401 and never touches the queue', async () => {
    verifyQStashSignature.mockReturnValue({ ok: false, reason: 'bad_signature' })
    const res = await POST(makeRequest({ campaignId: CAMPAIGN_ID }))
    expect(res.status).toBe(401)
    expect(processHostCampaignChunk).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await POST(makeRequest('not json'))
    expect(res.status).toBe(400)
  })

  it('rejects a missing campaignId with 400', async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })
})

describe('POST — chunk processing and chaining', () => {
  it('processes one chunk and self-chains the next kick: { campaignId, link+1 }, 2s delay, NO dedup id', async () => {
    processHostCampaignChunk.mockResolvedValue({ status: 'chunk_sent', remaining: 30, sent: 50, failed: 0 })
    const res = await POST(makeRequest({ campaignId: CAMPAIGN_ID }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ success: true, chunk_sent: true, remaining: 30, chained: true })

    expect(processHostCampaignChunk).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID)
    expect(publishQueuePush).toHaveBeenCalledTimes(1)
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: CAMPAIGN_ID, link: 2 }, // the kick is link 1
      delaySeconds: CHAIN_DELAY_SECONDS,
    })
    // NO dedup id — a dedup id on an identical body would be swallowed
    // inside QStash's dedup window and break the chain.
    expect(publishQueuePush.mock.calls[0][0]).not.toHaveProperty('deduplicationId')
  })

  it('increments the link counter along the chain', async () => {
    processHostCampaignChunk.mockResolvedValue({ status: 'chunk_sent', remaining: 5 })
    await POST(makeRequest({ campaignId: CAMPAIGN_ID, link: 7 }))
    expect(publishQueuePush.mock.calls[0][0].body).toEqual({ campaignId: CAMPAIGN_ID, link: 8 })
  })

  it('stops chaining at MAX_CHAIN and still 200s — the cron drains the remainder', async () => {
    processHostCampaignChunk.mockResolvedValue({ status: 'chunk_sent', remaining: 500 })
    const res = await POST(makeRequest({ campaignId: CAMPAIGN_ID, link: MAX_CHAIN }))
    expect(res.status).toBe(200)
    expect((await res.json()).chained).toBe(false)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('a garbage link value is treated as the first link, not a chain-breaker', async () => {
    processHostCampaignChunk.mockResolvedValue({ status: 'chunk_sent', remaining: 5 })
    await POST(makeRequest({ campaignId: CAMPAIGN_ID, link: 'banana' }))
    expect(publishQueuePush.mock.calls[0][0].body).toEqual({ campaignId: CAMPAIGN_ID, link: 2 })
  })

  it('a chain-publish failure still 200s (chained:false) — the cron sweeps the remainder', async () => {
    processHostCampaignChunk.mockResolvedValue({ status: 'chunk_sent', remaining: 30 })
    publishQueuePush.mockResolvedValue({ ok: false, error: 'qstash_500' })
    const res = await POST(makeRequest({ campaignId: CAMPAIGN_ID }))
    expect(res.status).toBe(200)
    expect((await res.json()).chained).toBe(false)
  })

  it.each(['drained', 'halted', 'skipped'])('%s → 200 with no chain publish', async (status) => {
    processHostCampaignChunk.mockResolvedValue({ status })
    const res = await POST(makeRequest({ campaignId: CAMPAIGN_ID }))
    expect(res.status).toBe(200)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('failed (infra) → 500 with no chain publish, so QStash redelivers this link', async () => {
    processHostCampaignChunk.mockResolvedValue({ status: 'failed', error: 'host load failed: boom' })
    const res = await POST(makeRequest({ campaignId: CAMPAIGN_ID }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('host load failed: boom')
    expect(publishQueuePush).not.toHaveBeenCalled()
  })
})
