// HOST-METRICS.1 — Postmark backfill contract.
//
// Two units under test:
//   • foldMessageEvents(events) — pure map from a Postmark MessageEvents
//     array to the host_campaign_sends patch (mig 590 columns). First-of-kind
//     timestamps, counts by multiplicity, bounce-type classification, and the
//     SubscriptionChanged → unsubscribed_at gate on SuppressSending.
//   • backfillHostCampaignEvents(db, opts) — walks a host's campaigns,
//     matches Postmark's own outbound-message history back onto our
//     host_campaign_sends rows by Metadata, and folds. Idempotent by null
//     guards (timestamps) and zero-count guards (open_count/click_count) —
//     load-bearing because Postmark retains only 45 days and this is meant
//     to be safely re-run.
//
// The Supabase client is faked with the chainable thenable recorder
// (host-campaign-queue.test.js style) — no DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark-messages.js', () => ({
  listOutboundMessages: vi.fn(),
  getOutboundMessageDetails: vi.fn(),
}))
vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { listOutboundMessages, getOutboundMessageDetails } from './postmark-messages.js'
import { foldMessageEvents, backfillHostCampaignEvents } from './host-campaign-backfill.js'

// ── chainable fake, modeled on host-campaign-queue.test.js ──────────
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

// cfg: { campaigns, rows } — host_campaigns select and host_campaign_sends
// select both return a single page; host_campaign_sends update echoes a
// fixed row so writes are recorded and asserted against via `statements`.
function routeFor(cfg = {}) {
  return (state) => {
    if (state.table === 'host_campaigns') {
      return { data: cfg.campaigns ?? [{ id: 'hc-1' }], error: null }
    }
    if (state.table === 'host_campaign_sends') {
      const first = state.ops[0]
      if (first?.method === 'update') return { data: [{ id: 'x' }], error: null }
      return { data: cfg.rows ?? [], error: null }
    }
    return {}
  }
}

describe('foldMessageEvents', () => {
  it('maps Postmark event types to the row patch: first-of-kind timestamps, counts by multiplicity', () => {
    const events = [
      { Type: 'Delivered', ReceivedAt: 'd1' },
      { Type: 'Opened', ReceivedAt: 'o1' }, { Type: 'Opened', ReceivedAt: 'o2' },
      { Type: 'LinkClicked', ReceivedAt: 'c1' },
      { Type: 'Bounced', ReceivedAt: 'b1', Details: { BounceID: '1' } },
      { Type: 'SubscriptionChanged', ReceivedAt: 'u1', Details: { SuppressSending: 'True' } },
    ]
    expect(foldMessageEvents(events)).toEqual({ delivered_at: 'd1', opened_at: 'o1', open_count: 2, clicked_at: 'c1', click_count: 1, bounced_at: 'b1', bounce_type: 'hard', unsubscribed_at: 'u1' })
  })

  it('a soft bounce reads soft; a transient event is ignored; SubscriptionChanged without SuppressSending is ignored', () => {
    expect(foldMessageEvents([{ Type: 'Bounced', ReceivedAt: 'b', Details: { Type: 'SoftBounce' } }]).bounce_type).toBe('soft')
    expect(foldMessageEvents([{ Type: 'Transient', ReceivedAt: 't' }])).toEqual({})
    expect(foldMessageEvents([{ Type: 'SubscriptionChanged', ReceivedAt: 'u', Details: { SuppressSending: 'False' } }])).toEqual({})
  })

  it('empty / non-array → {}', () => {
    expect(foldMessageEvents([])).toEqual({})
    expect(foldMessageEvents(null)).toEqual({})
  })
})

describe('backfillHostCampaignEvents', () => {
  const msg = (id, campaign = 'hc-1', contact = 'c-1', tag = 'host-campaign') => ({ MessageID: id, Tag: tag, Metadata: { host_campaign_id: campaign, host_id: 'h-1', contact_id: contact } })
  const row = (id, campaign = 'hc-1', contact = 'c-1', extra = {}) => ({ id, campaign_id: campaign, contact_id: contact, postmark_message_id: null, open_count: 0, click_count: 0, ...extra })

  beforeEach(() => {
    vi.clearAllMocks()
    getOutboundMessageDetails.mockResolvedValue({ details: { MessageEvents: [{ Type: 'Delivered', ReceivedAt: 'd' }, { Type: 'Opened', ReceivedAt: 'o' }] }, error: null })
  })

  it('dry run: counts what it would do, writes nothing', async () => {
    listOutboundMessages.mockResolvedValueOnce({ total: 1, messages: [msg('m1')], error: null })
    const { db, statements } = makeDb(routeFor({ rows: [row('s1')] }))
    const r = await backfillHostCampaignEvents(db, { hostId: 'h-1', dry: true, fromDate: '2026-07-23', toDate: '2026-09-07', sleep: async () => {} })
    expect(r).toEqual({ dry: true, scanned: 1, matched: 1, stamped: 1, updated: 1, skipped: 0, errors: [] })
    expect(statements.some((s) => s.table === 'host_campaign_sends' && op(s, 'update'))).toBe(false)
    expect(listOutboundMessages).toHaveBeenCalledWith({ tag: 'host-campaign', fromDate: '2026-07-23', toDate: '2026-09-07', count: 500, offset: 0 })
  })

  it('live: stamps the id guarded on null and folds events with null guards; counts only onto zero', async () => {
    listOutboundMessages.mockResolvedValueOnce({ total: 1, messages: [msg('m1')], error: null })
    const { db, statements } = makeDb(routeFor({ rows: [row('s1')] }))
    const r = await backfillHostCampaignEvents(db, { hostId: 'h-1', dry: false, sleep: async () => {} })
    expect(r).toMatchObject({ dry: false, stamped: 1, updated: 1 })
    const upds = statements.filter((s) => s.table === 'host_campaign_sends' && op(s, 'update'))
    const stamp = upds.find((s) => 'postmark_message_id' in op(s, 'update').args[0])
    expect(stamp.ops.some((o) => o.method === 'is' && o.args[0] === 'postmark_message_id' && o.args[1] === null)).toBe(true)
    const deliv = upds.find((s) => 'delivered_at' in op(s, 'update').args[0])
    expect(deliv.ops.some((o) => o.method === 'is' && o.args[0] === 'delivered_at')).toBe(true)
    const cnt = upds.find((s) => 'open_count' in op(s, 'update').args[0])
    expect(cnt.ops.some((o) => o.method === 'eq' && o.args[0] === 'open_count' && o.args[1] === 0)).toBe(true)
  })

  it('a row that already has counts is not re-counted and an existing id is not re-stamped', async () => {
    listOutboundMessages.mockResolvedValueOnce({ total: 1, messages: [msg('m1')], error: null })
    const { db, statements } = makeDb(routeFor({ rows: [row('s1', 'hc-1', 'c-1', { postmark_message_id: 'm1', open_count: 2 })] }))
    const r = await backfillHostCampaignEvents(db, { hostId: 'h-1', dry: false, sleep: async () => {} })
    expect(r.stamped).toBe(0)
    expect(statements.some((s) => s.table === 'host_campaign_sends' && op(s, 'update') && 'open_count' in op(s, 'update').args[0])).toBe(false)
  })

  it('messages for another host, unknown rows, and test sends are skipped', async () => {
    listOutboundMessages.mockResolvedValueOnce({ total: 3, messages: [msg('m1', 'hc-other'), msg('m2', 'hc-1', 'c-unknown'), msg('m3', 'hc-1', 'c-1', 'host-campaign-test')], error: null })
    const { db } = makeDb(routeFor({ rows: [row('s1')] }))
    const r = await backfillHostCampaignEvents(db, { hostId: 'h-1', dry: true, sleep: async () => {} })
    expect(r).toMatchObject({ scanned: 3, matched: 0, skipped: 3 })
    expect(getOutboundMessageDetails).not.toHaveBeenCalled()
  })

  it('pages by offset until scanned reaches total', async () => {
    listOutboundMessages.mockResolvedValueOnce({ total: 501, messages: Array.from({ length: 500 }, (_, i) => msg(`m${i}`, 'hc-x')), error: null })
      .mockResolvedValueOnce({ total: 501, messages: [msg('m500', 'hc-x')], error: null })
    const { db } = makeDb(routeFor({ rows: [] }))
    const r = await backfillHostCampaignEvents(db, { hostId: 'h-1', dry: true, sleep: async () => {} })
    expect(r.scanned).toBe(501)
    expect(listOutboundMessages).toHaveBeenCalledTimes(2)
    expect(listOutboundMessages.mock.calls[1][0].offset).toBe(500)
  })

  it('a details error is collected per message and the run continues; a list error aborts with the error', async () => {
    listOutboundMessages.mockResolvedValueOnce({ total: 2, messages: [msg('m1'), msg('m2', 'hc-1', 'c-2')], error: null })
    getOutboundMessageDetails.mockResolvedValueOnce({ details: null, error: 'gone' })
    const { db } = makeDb(routeFor({ rows: [row('s1'), row('s2', 'hc-1', 'c-2')] }))
    const r = await backfillHostCampaignEvents(db, { hostId: 'h-1', dry: false, sleep: async () => {} })
    expect(r.errors).toEqual([{ message_id: 'm1', error: 'gone' }])
    expect(r.updated).toBe(1)

    listOutboundMessages.mockResolvedValueOnce({ total: 0, messages: [], error: 'Postmark API token not configured' })
    const r2 = await backfillHostCampaignEvents(db, { hostId: 'h-1', dry: true, sleep: async () => {} })
    expect(r2.errors[0].error).toMatch(/token/)
    expect(r2.scanned).toBe(0)
  })
})
