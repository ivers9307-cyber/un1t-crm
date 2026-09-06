// HOST-METRICS.1 — GET /api/host/emails/[id]/recipients: the report page's
// data source. Tenancy via getCurrentHost() + .eq('host_id') on the
// campaign (404, no enumeration); per-send outcome is DERIVED
// (host-campaign-outcome.js), never re-implemented here; campaign-level
// counts come from host_campaign_stats() (mig 590) and must never fail the
// page on a stats hiccup.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

const DEFAULT_CAMPAIGN = {
  id: CAMPAIGN_ID,
  subject: 'Race week',
  status: 'sent',
  email_type: 'marketing',
  audience_kind: 'all',
  sent_at: '2026-09-04T10:58:14Z',
  recipient_count: 3,
}

// ── chainable fake, copied from send/route.test.js's makeDb, plus an rpc
// hook (host_campaign_stats is called via db.rpc(), not db.from()) ────────
function makeDb(route) {
  const statements = []
  const rpcCalls = []
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
    rpc(fn, args) {
      rpcCalls.push([fn, args])
      return Promise.resolve(route({ table: 'rpc', fn, args, ops: [] }) ?? {})
    },
  }
  return { db, statements, rpcCalls }
}

const op = (state, method) => state.ops.find((o) => o.method === method)

function routeFor(cfg = {}) {
  let sendsPageIndex = 0
  return (state) => {
    if (state.table === 'rpc' && state.fn === 'host_campaign_stats') {
      return { data: cfg.stats ?? [], error: cfg.statsErr ?? null }
    }
    if (state.table === 'host_campaigns') {
      const campaign = Object.prototype.hasOwnProperty.call(cfg, 'campaign') ? cfg.campaign : DEFAULT_CAMPAIGN
      return { data: campaign, error: null }
    }
    if (state.table === 'host_campaign_sends') {
      const pages = cfg.pages ?? [[]]
      const page = pages[sendsPageIndex] ?? []
      sendsPageIndex += 1
      return { data: page, error: null }
    }
    return {}
  }
}

function makeRequest() {
  return new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/recipients`)
}
const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('GET /api/host/emails/[id]/recipients', () => {
  it('401s without a host session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await GET(makeRequest(), props)
    expect(res.status).toBe(401)
  })

  it('404s when the campaign select returns null, never calls the stats rpc, and scopes by host + id', async () => {
    const { db, rpcCalls, statements } = makeDb(routeFor({ campaign: null }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect(res.status).toBe(404)
    expect((await res.json())).toEqual({ success: false, error: 'Not found' })
    expect(rpcCalls).toHaveLength(0)

    const campaignStatement = statements.find((s) => s.table === 'host_campaigns')
    const eqCalls = campaignStatement.ops.filter((o) => o.method === 'eq').map((o) => o.args)
    expect(eqCalls).toContainEqual(['host_id', HOST_ID])
    expect(eqCalls).toContainEqual(['id', CAMPAIGN_ID])
  })

  it('200s with the campaign (+ derived stats) and every recipient (+ derived outcome)', async () => {
    const rows = [
      {
        id: 's1', contact_id: 'c1', email: 'a@x.ie', status: 'sent',
        sent_at: 't1', delivered_at: 't2', opened_at: 't3', open_count: 2,
        clicked_at: null, click_count: 0, bounced_at: null, bounce_type: null,
        complained_at: null, unsubscribed_at: null, failed_reason: null, claimed_at: null,
        contact: { name: null, first_name: 'Pat', last_name: 'Doe' },
      },
      {
        id: 's2', contact_id: 'c2', email: 'b@x.ie', status: 'failed',
        claimed_at: 't0', sent_at: null, failed_reason: 'no_host_consent',
        contact: { name: 'Sam' },
      },
    ]
    const stats = [{
      campaign_id: CAMPAIGN_ID, queued: '0', sent: '1', delivered: '1',
      opened: '1', clicked: '0', bounced: '0', complained: '0',
      unsubscribed: '0', failed: '1',
    }]
    const { db } = makeDb(routeFor({ pages: [rows], stats }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.campaign.stats).toEqual({
      queued: 0, sent: 1, delivered: 1, opened: 1, clicked: 0,
      bounced: 0, complained: 0, unsubscribed: 0, failed: 1,
    })

    expect(body.data.recipients[0]).toEqual({
      contact_id: 'c1', name: 'Pat Doe', email: 'a@x.ie',
      outcome: 'opened', outcome_at: 't3', failure_copy: null,
      sent_at: 't1', delivered_at: 't2', opened_at: 't3', open_count: 2,
      clicked_at: null, click_count: 0, bounced_at: null, bounce_type: null,
      complained_at: null, unsubscribed_at: null, failed_reason: null,
    })

    expect(body.data.recipients[1]).toMatchObject({
      name: 'Sam', outcome: 'failed', outcome_at: 't0',
      failure_copy: 'Not consented to your list',
    })
  })

  it('zeroes stats when the rpc has no row for this campaign', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], stats: [] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.campaign.stats).toEqual({
      queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0,
      bounced: 0, complained: 0, unsubscribed: 0, failed: 0,
    })
  })

  it('a stats rpc error still 200s with zero stats — never fails the page on a stats hiccup', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], statsErr: { message: 'rpc broke' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.campaign.stats).toEqual({
      queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0,
      bounced: 0, complained: 0, unsubscribed: 0, failed: 0,
    })
  })

  it('selects every outcome column plus the joined contact, and paginates past 1000 rows', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `s${i}`, contact_id: `c${i}`, email: `u${i}@x.ie`, status: 'sent',
      sent_at: `t${i}`, contact: null,
    }))
    const lastRow = [{ id: 's1000', contact_id: 'c1000', email: 'u1000@x.ie', status: 'sent', sent_at: 't1000', contact: null }]
    const { db, statements } = makeDb(routeFor({ pages: [fullPage, lastRow] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.recipients).toHaveLength(1001)

    const sendStatements = statements.filter((s) => s.table === 'host_campaign_sends')
    expect(sendStatements).toHaveLength(2)
    expect(op(sendStatements[0], 'range').args).toEqual([0, 999])
    expect(op(sendStatements[1], 'range').args).toEqual([1000, 1999])

    const selectArg = op(sendStatements[0], 'select').args[0]
    expect(selectArg).toContain('contact:contacts!contact_id')
    for (const col of [
      'postmark_message_id', 'delivered_at', 'opened_at', 'open_count',
      'clicked_at', 'click_count', 'bounced_at', 'bounce_type',
      'complained_at', 'unsubscribed_at', 'failed_reason',
    ]) {
      expect(selectArg).toContain(col)
    }
  })

  it('orders by sent_at desc (nulls last) then email', async () => {
    const { db, statements } = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(db)
    await GET(makeRequest(), props)
    const sendStatement = statements.find((s) => s.table === 'host_campaign_sends')
    const orderCalls = sendStatement.ops.filter((o) => o.method === 'order')
    expect(orderCalls[0].args).toEqual(['sent_at', { ascending: false, nullsFirst: false }])
    expect(orderCalls[1].args[0]).toBe('email')
  })
})
