// HOST-SCHEDULE.1 — launchHostCampaign is the ONE launch path for a host
// campaign: the send route (trigger 'send_now') and the sweeper cron
// (trigger 'schedule') both call it. Gates, in order: own campaign → sender
// verified → stream for marketing → daily cap → recipients → CAS to
// 'sending' → chunked enqueue → QStash kick. The trigger changes ONLY the
// CAS's from-status. Refusals come back as { ok:false, reason, status,
// error } so the route can answer with the same statuses it always has and
// the sweeper can write the reason onto the row.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-campaign-email', () => ({ resolveHostRecipients: vi.fn() }))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-kick' }),
  HOST_CAMPAIGNS_WORKER_PATH: '/api/webhooks/qstash/host-campaigns',
}))

import { launchHostCampaign, LAUNCH_MESSAGES, LAUNCH_GATE_REASONS } from './host-campaign-launch.js'
import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

const HOST_ROW = {
  id: HOST_ID,
  sender_domain_verified: true,
  sender_email: 'news@runners.ie',
  sender_name: 'Dublin Runners CC',
  email_daily_send_cap: 2,
  postmark_stream_id: 'colm-events',
}

// ── chainable fake (same shape as send/route.test.js) ─────────────────
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
    const first = state.ops[0]
    if (state.table === 'host_campaigns') {
      // first.args[1]?.head tells the head-count (daily-cap) query apart
      // from the campaign read — both are a `.select()` on host_campaigns,
      // but only the count query passes `{ count: 'exact', head: true }`.
      if (first.method === 'select' && first.args[1]?.head) return { count: cfg.sentToday ?? 0, error: cfg.capErr ?? null }
      if (first.method === 'select') {
        if (cfg.campaignReadErr) return { data: null, error: cfg.campaignReadErr }
        // cfg.campaign === undefined ? default row : cfg.campaign — undefined
        // means "use the default row", while an explicit null means "row is
        // missing" (not_found), so a test that wants a missing row must pass
        // `campaign: null` rather than simply omitting the key.
        return { data: cfg.campaign === undefined ? { id: CAMPAIGN_ID, status: 'draft', email_type: 'marketing', audience_kind: 'all', audience_event_id: null } : cfg.campaign, error: null }
      }
      if (first.method === 'update') return { data: cfg.casRows ?? [{ id: CAMPAIGN_ID }], error: cfg.casErr ?? null }
    }
    if (state.table === 'event_hosts') {
      if (cfg.hostReadErr) return { data: null, error: cfg.hostReadErr }
      // Same null-vs-undefined idiom as the campaign read above.
      return { data: cfg.host === undefined ? HOST_ROW : cfg.host, error: null }
    }
    if (state.table === 'host_campaign_sends') return { error: cfg.enqueueErr ?? null }
    return {}
  }
}

const launch = (db, trigger = 'send_now') => launchHostCampaign(db, { campaignId: CAMPAIGN_ID, hostId: HOST_ID, trigger })

beforeEach(() => {
  vi.clearAllMocks()
  publishQueuePush.mockResolvedValue({ ok: true, messageId: 'msg-kick' })
  resolveHostRecipients.mockResolvedValue([
    { contact_id: 'c1', email: 'a@x.ie' },
    { contact_id: 'c2', email: 'b@x.ie' },
  ])
})

describe('LAUNCH_GATE_REASONS', () => {
  it('lists exactly the pre-CAS gate refusals, for the sweeper to import', () => {
    expect(LAUNCH_GATE_REASONS).toEqual(['sender_not_verified', 'no_stream', 'daily_cap', 'no_recipients'])
  })
})

describe('launchHostCampaign — happy path', () => {
  it("send_now: CAS draft→sending, enqueues, kicks once, returns the recipient count", async () => {
    const { db, statements } = makeDb(routeFor())
    const r = await launch(db, 'send_now')
    expect(r).toEqual({ ok: true, recipientCount: 2 })

    const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(cas, 'update').args[0]).toEqual({ status: 'sending', recipient_count: 2 })
    expect(hasEq(cas, 'status', 'draft')).toBe(true)

    const enqueue = statements.find((s) => s.table === 'host_campaign_sends')
    expect(op(enqueue, 'upsert').args[0]).toEqual([
      { campaign_id: CAMPAIGN_ID, contact_id: 'c1', email: 'a@x.ie', status: 'pending' },
      { campaign_id: CAMPAIGN_ID, contact_id: 'c2', email: 'b@x.ie', status: 'pending' },
    ])
    expect(op(enqueue, 'upsert').args[1]).toEqual({ onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })

    expect(publishQueuePush).toHaveBeenCalledTimes(1)
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: CAMPAIGN_ID },
      deduplicationId: `host-campaign-${CAMPAIGN_ID}-kick`,
    })
  })

  it("schedule: the CAS is from 'scheduled', everything else is identical", async () => {
    const { db, statements } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'scheduled', email_type: 'marketing', audience_kind: 'all', audience_event_id: null } }))
    const r = await launch(db, 'schedule')
    expect(r.ok).toBe(true)
    const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(hasEq(cas, 'status', 'scheduled')).toBe(true)
    expect(hasEq(cas, 'status', 'draft')).toBe(false)
    expect(publishQueuePush).toHaveBeenCalledTimes(1)
  })

  it('the kick is published only AFTER the last enqueue chunk', async () => {
    const order = []
    const { db } = makeDb((state) => {
      if (state.table === 'host_campaign_sends') { order.push('upsert'); return { error: null } }
      return routeFor()(state)
    })
    publishQueuePush.mockImplementation(async () => { order.push('publish'); return { ok: true } })
    await launch(db)
    expect(order).toEqual(['upsert', 'publish'])
  })

  it('a publish rejection never fails the launch', async () => {
    publishQueuePush.mockRejectedValue(new Error('qstash exploded'))
    const { db } = makeDb(routeFor())
    expect((await launch(db)).ok).toBe(true)
  })

  it('chunks 1,200 recipients into 500/500/200 upserts, kicking once AFTER the third chunk', async () => {
    resolveHostRecipients.mockResolvedValue(
      Array.from({ length: 1200 }, (_, i) => ({ contact_id: `c${i}`, email: `${i}@x.ie` }))
    )
    const order = []
    const { db, statements } = makeDb((state) => {
      if (state.table === 'host_campaign_sends') { order.push('upsert'); return { error: null } }
      return routeFor()(state)
    })
    publishQueuePush.mockImplementation(async () => { order.push('publish'); return { ok: true } })
    const r = await launch(db)
    expect(r).toEqual({ ok: true, recipientCount: 1200 })
    expect(order).toEqual(['upsert', 'upsert', 'upsert', 'publish'])
    const enqueues = statements.filter((s) => s.table === 'host_campaign_sends')
    expect(enqueues).toHaveLength(3)
    expect(enqueues.map((s) => op(s, 'upsert').args[0].length)).toEqual([500, 500, 200])
  })

  it('scopes the campaign read to the host (tenancy) and resolves recipients with the campaign audience', async () => {
    const { db, statements } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility', audience_kind: 'event', audience_event_id: 'ev1' } }))
    await launch(db)
    const read = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(read, 'host_id', HOST_ID)).toBe(true)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, { audienceEventId: 'ev1', mailingListOnly: false, emailType: 'utility' })
  })
})

describe('launchHostCampaign — refusals (nothing enqueued, nothing published)', () => {
  // `expectCas` distinguishes a pre-CAS refusal (no host_campaigns update
  // should ever be attempted) from cas_lost/db_error, which reach the CAS
  // update and refuse based on ITS outcome. `extra` gets the raw statements
  // for a refusal that needs to inspect the CAS call itself (e.g. its
  // from-status).
  const refusal = async (cfg, trigger, { expectCas = false, extra } = {}) => {
    const { db, statements } = makeDb(routeFor(cfg))
    const r = await launch(db, trigger)
    expect(r.ok).toBe(false)
    expect(statements.some((s) => s.table === 'host_campaign_sends')).toBe(false)
    expect(publishQueuePush).not.toHaveBeenCalled()
    const casUpdate = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    if (expectCas) expect(casUpdate).toBeTruthy()
    else expect(casUpdate).toBeUndefined()
    extra?.(statements)
    return r
  }

  it('not_found 404 when the campaign is not this host\'s', async () => {
    const r = await refusal({ campaign: null })
    expect(r).toMatchObject({ reason: 'not_found', status: 404, error: LAUNCH_MESSAGES.not_found })
  })

  it('sender_not_verified 409 (kill switch)', async () => {
    const r = await refusal({ host: { ...HOST_ROW, sender_domain_verified: false } })
    expect(r).toMatchObject({ reason: 'sender_not_verified', status: 409, error: LAUNCH_MESSAGES.sender_not_verified })
  })

  it('sender_not_verified when verified but the sender email is missing (provisioning inconsistency)', async () => {
    const r = await refusal({ host: { ...HOST_ROW, sender_email: null } })
    expect(r.reason).toBe('sender_not_verified')
  })

  it('no_stream 409 for a marketing campaign without a host stream', async () => {
    const r = await refusal({ host: { ...HOST_ROW, postmark_stream_id: null } })
    expect(r).toMatchObject({ reason: 'no_stream', status: 409 })
  })

  it('a utility campaign passes the stream gate even without a host stream', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility', audience_kind: 'all' } }))
    expect((await launch(db)).ok).toBe(true)
  })

  it('db_error 500 when the campaign read itself errors', async () => {
    const r = await refusal({ campaignReadErr: { message: 'campaign read boom' } })
    expect(r).toMatchObject({ reason: 'db_error', status: 500, error: 'campaign read boom' })
  })

  it('db_error 500 when the host read itself errors', async () => {
    const r = await refusal({ hostReadErr: { message: 'host read boom' } })
    expect(r).toMatchObject({ reason: 'db_error', status: 500, error: 'host read boom' })
  })

  it('daily_cap 409 once today\'s sending/sent count reaches the cap', async () => {
    let capQuery
    const r = await refusal({ sentToday: 2 }, undefined, {
      extra: (statements) => {
        capQuery = statements.find((s) => s.table === 'host_campaigns' && op(s, 'select')?.args[1]?.head)
      },
    })
    expect(r).toMatchObject({ reason: 'daily_cap', status: 409, error: LAUNCH_MESSAGES.daily_cap })
    expect(hasEq(capQuery, 'host_id', HOST_ID)).toBe(true)
    expect(capQuery.ops.some((o) => o.method === 'in' && o.args[0] === 'status' && o.args[1].join() === ['sending', 'sent'].join())).toBe(true)
    expect(capQuery.ops.some((o) => o.method === 'gte' && o.args[0] === 'created_at')).toBe(true)
  })

  it('db_error 500 when the cap count fails', async () => {
    const r = await refusal({ capErr: { message: 'boom' } })
    expect(r).toMatchObject({ reason: 'db_error', status: 500, error: 'boom' })
  })

  it('daily_cap 409 when email_daily_send_cap is null and sentToday reaches the default cap of 2', async () => {
    const r = await refusal({ host: { ...HOST_ROW, email_daily_send_cap: null }, sentToday: 2 })
    expect(r).toMatchObject({ reason: 'daily_cap', status: 409, error: LAUNCH_MESSAGES.daily_cap })
  })

  it('a null email_daily_send_cap still allows a send under the default cap of 2', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, email_daily_send_cap: null }, sentToday: 1 }))
    expect((await launch(db)).ok).toBe(true)
  })

  it('no_recipients 409 when nobody is emailable', async () => {
    resolveHostRecipients.mockResolvedValue([])
    const r = await refusal({})
    expect(r).toMatchObject({ reason: 'no_recipients', status: 409, error: LAUNCH_MESSAGES.no_recipients })
  })

  it('resolve_failed 500 when the resolver throws', async () => {
    resolveHostRecipients.mockRejectedValue(new Error('resolver down'))
    const r = await refusal({})
    expect(r).toMatchObject({ reason: 'resolve_failed', status: 500, error: 'resolver down' })
  })

  it('cas_lost 409 when the CAS matches no row (double send / already fired)', async () => {
    const r = await refusal({ casRows: [] }, undefined, { expectCas: true })
    expect(r).toMatchObject({ reason: 'cas_lost', status: 409, error: LAUNCH_MESSAGES.cas_lost })
  })

  it("cas_lost under trigger 'schedule' CASes from 'scheduled', not 'draft'", async () => {
    const r = await refusal({ casRows: [] }, 'schedule', {
      expectCas: true,
      extra: (statements) => {
        const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
        expect(hasEq(cas, 'status', 'scheduled')).toBe(true)
        expect(hasEq(cas, 'status', 'draft')).toBe(false)
      },
    })
    expect(r).toMatchObject({ reason: 'cas_lost', status: 409, error: LAUNCH_MESSAGES.cas_lost })
  })

  it("sender_not_verified still refuses (409) under trigger 'schedule'", async () => {
    const r = await refusal({ host: { ...HOST_ROW, sender_domain_verified: false } }, 'schedule')
    expect(r).toMatchObject({ reason: 'sender_not_verified', status: 409, error: LAUNCH_MESSAGES.sender_not_verified })
  })

  it('db_error 500 when the CAS update itself errors', async () => {
    const r = await refusal({ casErr: { message: 'cas broke' } }, undefined, { expectCas: true })
    expect(r).toMatchObject({ reason: 'db_error', status: 500, error: 'cas broke' })
  })

  it('not_found 404 when the host row is missing', async () => {
    const r = await refusal({ host: null })
    expect(r).toMatchObject({ reason: 'not_found', status: 404, error: LAUNCH_MESSAGES.not_found })
  })

  it('enqueue_failed 500 after the CAS: no kick (the cron drains what landed)', async () => {
    const { db } = makeDb(routeFor({ enqueueErr: { message: 'insert failed' } }))
    const r = await launch(db)
    expect(r).toMatchObject({ ok: false, reason: 'enqueue_failed', status: 500, error: 'Queueing failed: insert failed' })
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('a failure on the SECOND chunk stops the loop: only 2 upsert statements, no kick', async () => {
    resolveHostRecipients.mockResolvedValue(
      Array.from({ length: 1200 }, (_, i) => ({ contact_id: `c${i}`, email: `${i}@x.ie` }))
    )
    let sendsCall = 0
    const { db, statements } = makeDb((state) => {
      if (state.table === 'host_campaign_sends') {
        sendsCall += 1
        return sendsCall === 1 ? { error: null } : { error: { message: 'chunk 2 failed' } }
      }
      return routeFor()(state)
    })
    const r = await launch(db)
    expect(r).toMatchObject({ ok: false, reason: 'enqueue_failed', status: 500, error: 'Queueing failed: chunk 2 failed' })
    expect(publishQueuePush).not.toHaveBeenCalled()
    expect(statements.filter((s) => s.table === 'host_campaign_sends')).toHaveLength(2)
  })
})
