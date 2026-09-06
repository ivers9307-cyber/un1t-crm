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
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/host-campaign-queue', () => ({
  processHostCampaignChunk: vi.fn(),
}))
vi.mock('@/lib/host-campaign-launch', () => ({
  launchHostCampaign: vi.fn(),
  LAUNCH_GATE_REASONS: Object.freeze(['sender_not_verified', 'no_stream', 'daily_cap', 'no_recipients']),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'
import { processHostCampaignChunk } from '@/lib/host-campaign-queue'
import { launchHostCampaign } from '@/lib/host-campaign-launch'

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
    if (state.table === 'host_campaigns') {
      // The back-to-draft write ALSO carries eq('status','scheduled') now
      // that it has a .select() too — check for the update op FIRST, then
      // the scheduled-status select (the due pick), then fall through to
      // the sending pick.
      if (op(state, 'update')) return { data: cfg.backRows ?? [{ id: 'x' }], error: cfg.backErr ?? null }
      if (hasEq(state, 'status', 'scheduled') && op(state, 'select')) return { data: cfg.due ?? [], error: cfg.dueErr ?? null }
      return { data: cfg.campaigns ?? [], error: cfg.pickErr ?? null }
    }
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
  launchHostCampaign.mockResolvedValue({ ok: true, recipientCount: 5 })
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

    // Positional, not selector-narrowed: [0] is the due pick (no due rows
    // here, no refusals, so no back-to-draft write either), [1] is the
    // sending pick — asserting status='sending' on it is meaningful only
    // because we didn't select for that status to find it.
    const hostCampaignsStatements = statements.filter((s) => s.table === 'host_campaigns')
    const pick = hostCampaignsStatements[1]
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

// HOST-SCHEDULE.1 — due scheduled campaigns are launched at the top of the
// tick, before the 'sending' pass, through the SAME launchHostCampaign the
// send route uses. See launchDueCampaigns's own comment in route.js for the
// full, authoritative refusal mapping.
describe('GET /api/cron/send-host-campaigns — scheduled launches', () => {
  const DUE_1 = { id: 'd0000000-0000-0000-0000-0000000000d1', host_id: 'h1' }
  const DUE_2 = { id: 'd0000000-0000-0000-0000-0000000000d2', host_id: 'h2' }

  it('picks due scheduled rows (scheduled_for <= now, ordered, ≤10) and launches each with trigger schedule, before the sending pass', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1, DUE_2], campaigns: [CAMPAIGN_A] }))
    createServerClient.mockReturnValue(db)
    const order = []
    launchHostCampaign.mockImplementation(async () => { order.push('launch'); return { ok: true, recipientCount: 5 } })
    processHostCampaignChunk.mockImplementation(async () => { order.push('chunk'); return { status: 'drained', sent: 1, failed: 0 } })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.launched).toBe(2)
    expect(body.refused).toEqual([])

    const pick = statements.find((s) => s.table === 'host_campaigns' && hasEq(s, 'status', 'scheduled'))
    expect(op(pick, 'lte').args[0]).toBe('scheduled_for')
    expect(op(pick, 'order').args[0]).toBe('scheduled_for')
    expect(op(pick, 'limit').args[0]).toBe(10)

    expect(launchHostCampaign).toHaveBeenNthCalledWith(1, db, { campaignId: DUE_1.id, hostId: 'h1', trigger: 'schedule' })
    expect(launchHostCampaign).toHaveBeenNthCalledWith(2, db, { campaignId: DUE_2.id, hostId: 'h2', trigger: 'schedule' })
    expect(order).toEqual(['launch', 'launch', 'chunk'])
    expect(stampHeartbeat).toHaveBeenCalledWith('send-host-campaigns')
  })

  it('a refused launch goes back to draft with the reason (CAS on scheduled) and the tick carries on', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1], campaigns: [CAMPAIGN_A] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'daily_cap', status: 409, error: 'Daily send limit reached.' })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.launched).toBe(0)
    expect(body.refused).toEqual([{ campaign_id: DUE_1.id, reason: 'daily_cap' }])

    const back = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(back, 'update').args[0]).toEqual({ status: 'draft', scheduled_for: null, schedule_error: 'daily_cap' })
    expect(hasEq(back, 'id', DUE_1.id)).toBe(true)
    expect(hasEq(back, 'status', 'scheduled')).toBe(true)
    expect(op(back, 'select').args[0]).toBe('id')
    expect(processHostCampaignChunk).toHaveBeenCalledWith(db, CAMPAIGN_A.id)
  })

  it('daily_cap and no_recipients are the host\'s own state — logWarn, not logError', async () => {
    const { db } = makeDb(routeFor({ due: [DUE_1] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'no_recipients', status: 409, error: 'No emailable contacts.' })

    await GET(req())
    expect(logWarn).toHaveBeenCalledWith('host-campaigns', 'scheduled launch refused', expect.objectContaining({ reason: 'no_recipients' }))
    expect(logError).not.toHaveBeenCalledWith('host-campaigns', 'scheduled launch refused', expect.anything())
  })

  it('sender_not_verified is a real failure — logError, not logWarn', async () => {
    const { db } = makeDb(routeFor({ due: [DUE_1] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'sender_not_verified', status: 409, error: 'not verified' })

    await GET(req())
    expect(logError).toHaveBeenCalledWith('host-campaigns', 'scheduled launch refused', expect.objectContaining({ reason: 'sender_not_verified' }))
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a back-to-draft write error lands in errors, not refused', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1], backErr: { message: 'write boom' } }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'daily_cap', status: 409, error: 'Daily send limit reached.' })

    const body = await (await GET(req())).json()
    expect(body.refused).toEqual([])
    expect(body.errors).toEqual([{ campaign_id: DUE_1.id, error: 'write boom' }])
    expect(logError).toHaveBeenCalledWith('host-campaigns', 'scheduled refusal write failed', { campaign_id: DUE_1.id, error: 'write boom' })
    const back = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(back, 'select').args[0]).toBe('id')
  })

  it('a back-to-draft write matching 0 rows (cas lost meanwhile) is a silent skip — neither errors nor refused', async () => {
    const { db } = makeDb(routeFor({ due: [DUE_1], backRows: [] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'daily_cap', status: 409, error: 'Daily send limit reached.' })

    const body = await (await GET(req())).json()
    expect(body.refused).toEqual([])
    expect(body.errors).toEqual([])
  })

  it('a transient failure (db_error) is deferred for retry, not sent back to draft; cas_lost is silent', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1, DUE_2] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign
      .mockResolvedValueOnce({ ok: false, reason: 'db_error', status: 500, error: 'boom' })
      .mockResolvedValueOnce({ ok: false, reason: 'cas_lost', status: 409, error: 'This email has already been sent.' })

    const body = await (await GET(req())).json()
    expect(body.refused).toEqual([])
    expect(body.errors).toEqual([{ campaign_id: DUE_1.id, error: 'boom' }])
    const backs = statements.filter((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(backs).toHaveLength(0)
  })

  it('a stale resolve_failed (scheduled_for over an hour ago) is treated as launch_failed and sent back to draft', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    const staleDue = { ...DUE_1, scheduled_for: twoHoursAgo }
    const { db, statements } = makeDb(routeFor({ due: [staleDue] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'resolve_failed', status: 500, error: 'resolver exploded' })

    const body = await (await GET(req())).json()
    expect(body.refused).toEqual([{ campaign_id: DUE_1.id, reason: 'launch_failed' }])
    expect(body.errors).toEqual([])
    const back = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(back, 'update').args[0]).toEqual({ status: 'draft', scheduled_for: null, schedule_error: 'launch_failed' })
  })

  it('a fresh resolve_failed (scheduled_for a minute ago) is still deferred, not sent back to draft', async () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString()
    const freshDue = { ...DUE_1, scheduled_for: oneMinuteAgo }
    const { db, statements } = makeDb(routeFor({ due: [freshDue] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'resolve_failed', status: 500, error: 'resolver exploded' })

    const body = await (await GET(req())).json()
    expect(body.refused).toEqual([])
    expect(body.errors).toEqual([{ campaign_id: DUE_1.id, error: 'resolver exploded' }])
    const backs = statements.filter((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(backs).toHaveLength(0)
  })

  it('a post-CAS enqueue_failed leaves the row sending and is deferred to errors, not sent back to draft', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'enqueue_failed', status: 500, error: 'Queueing failed: boom' })

    const body = await (await GET(req())).json()
    expect(body.refused).toEqual([])
    expect(body.errors).toEqual([{ campaign_id: DUE_1.id, error: 'Queueing failed: boom' }])
    const backs = statements.filter((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(backs).toHaveLength(0)
  })

  it('a thrown launch is a launch_failed, never a 500 tick', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockRejectedValue(new Error('exploded'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).refused).toEqual([{ campaign_id: DUE_1.id, reason: 'launch_failed' }])
    const back = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(back, 'update').args[0]).toEqual({ status: 'draft', scheduled_for: null, schedule_error: 'launch_failed' })
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('a failed due pick is logged into errors and the sending pass still runs', async () => {
    const { db } = makeDb(routeFor({ dueErr: { message: 'pick broke' }, campaigns: [CAMPAIGN_A] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.errors).toEqual([{ stage: 'due_pick', error: 'pick broke' }])
    expect(launchHostCampaign).not.toHaveBeenCalled()
    expect(processHostCampaignChunk).toHaveBeenCalledWith(db, CAMPAIGN_A.id)
  })
})
