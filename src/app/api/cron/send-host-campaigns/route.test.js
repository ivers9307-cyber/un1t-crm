// QSTASH.8 — the send-host-campaigns cron as SWEEPER over the shared
// chunk processor (src/lib/host-campaign-queue.js).
//
// The cron keeps three responsibilities the QStash worker deliberately
// does NOT have: the ≤5-campaigns-per-tick outer loop, the stale-claim
// sweep (claimed rows a crashed consumer left behind go terminal
// 'failed' after CLAIM_STALE_MS — no attempts column, so terminal is
// the only never-double-send choice), and the heartbeat. Per campaign
// it sweeps FIRST (so a swept campaign can finalise in the same tick's
// chunk call) then delegates the chunk to the shared lib.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/host-campaign-queue', () => ({
  processHostCampaignChunk: vi.fn(),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { processHostCampaignChunk } from '@/lib/host-campaign-queue'

const CAMPAIGN_A = { id: 'a0000000-0000-0000-0000-0000000000a1', host_id: 'h1', status: 'sending' }
const CAMPAIGN_B = { id: 'a0000000-0000-0000-0000-0000000000a2', host_id: 'h1', status: 'sending' }

// ── chainable fake ─────────────────────────────────────────────────
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}

const op = (state, method) => state.ops.find((o) => o.method === method)
const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

function routeFor(cfg = {}) {
  return (state) => {
    if (state.table === 'host_campaigns') return { data: cfg.campaigns ?? [], error: cfg.pickErr ?? null }
    if (state.table === 'host_campaign_sends') return { data: cfg.swept ?? [], error: null } // stale sweep
    return {}
  }
}

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  processHostCampaignChunk.mockResolvedValue({ status: 'chunk_sent', remaining: 3, sent: 2, failed: 0 })
})

describe('GET /api/cron/send-host-campaigns', () => {
  it('rejects a missing/wrong bearer', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(processHostCampaignChunk).not.toHaveBeenCalled()
  })

  it('500s when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req())
    expect(res.status).toBe(500)
  })

  it('sweeps stale claims per campaign BEFORE the chunk, then delegates to the shared lib', async () => {
    const { db, statements } = makeDb(routeFor({ campaigns: [CAMPAIGN_A] }))
    createServerClient.mockReturnValue(db)
    const order = []
    processHostCampaignChunk.mockImplementation(async () => { order.push('chunk'); return { status: 'drained', sent: 1, failed: 0 } })

    const res = await GET(req())
    expect(res.status).toBe(200)

    const sweep = statements.find((s) => s.table === 'host_campaign_sends')
    expect(op(sweep, 'update').args[0]).toEqual({ status: 'failed', failed_reason: 'stale_claim' })
    expect(hasEq(sweep, 'campaign_id', CAMPAIGN_A.id)).toBe(true)
    expect(hasEq(sweep, 'status', 'claimed')).toBe(true)
    expect(op(sweep, 'lt').args[0]).toBe('claimed_at') // only STALE claims — in-flight ones are live
    expect(order).toEqual(['chunk']) // sweep is a db statement; the chunk ran after it
    expect(processHostCampaignChunk).toHaveBeenCalledWith(db, CAMPAIGN_A.id)
  })

  it('processes up to 5 sending campaigns oldest-first and aggregates the summary', async () => {
    const { db, statements } = makeDb(routeFor({ campaigns: [CAMPAIGN_A, CAMPAIGN_B] }))
    createServerClient.mockReturnValue(db)
    processHostCampaignChunk
      .mockResolvedValueOnce({ status: 'chunk_sent', remaining: 9, sent: 50, failed: 1 })
      .mockResolvedValueOnce({ status: 'drained', sent: 3, failed: 0 })

    const res = await GET(req())
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, campaigns: 2, sent: 53, failed: 1, finalised: 1, errors: [] })

    const pick = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(pick, 'status', 'sending')).toBe(true)
    expect(op(pick, 'limit').args[0]).toBe(5)
    expect(op(pick, 'order').args[0]).toBe('created_at')
    expect(stampHeartbeat).toHaveBeenCalledWith('send-host-campaigns')
  })

  it('a failed chunk lands in errors without stopping the other campaigns or the heartbeat', async () => {
    const { db } = makeDb(routeFor({ campaigns: [CAMPAIGN_A, CAMPAIGN_B] }))
    createServerClient.mockReturnValue(db)
    processHostCampaignChunk
      .mockResolvedValueOnce({ status: 'failed', error: 'host load failed: boom' })
      .mockResolvedValueOnce({ status: 'halted', sent: 0, failed: 0 })

    const res = await GET(req())
    const json = await res.json()
    expect(json.errors).toEqual([{ campaign_id: CAMPAIGN_A.id, error: 'host load failed: boom' }])
    expect(json.campaigns).toBe(1) // only the campaign that ticked cleanly
    expect(processHostCampaignChunk).toHaveBeenCalledTimes(2)
    expect(stampHeartbeat).toHaveBeenCalledWith('send-host-campaigns')
  })

  it('a campaign-pick error 500s but still stamps the heartbeat', async () => {
    const { db } = makeDb(routeFor({ pickErr: { message: 'pick broke' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).toHaveBeenCalledWith('send-host-campaigns')
  })
})
