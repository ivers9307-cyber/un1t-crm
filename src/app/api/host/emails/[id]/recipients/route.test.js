// HOST-METRICS.1 — GET /api/host/emails/[id]/recipients: the report page's
// data source. Tenancy via getCurrentHost() + .eq('host_id') on the
// campaign (404, no enumeration); per-send outcome is DERIVED
// (host-campaign-outcome.js), never re-implemented here; campaign-level
// counts come from host_campaign_stats() (mig 590) and must never fail the
// page on a stats hiccup.
//
// HOST-EMAILS.2 — `paused_reason` (real hostSendBlockReason predicate, same
// as the list route), `non_openers_count` (resolveHostRecipients with
// nonOpenersOf: campaign.id, null on failure) and top-level `links`
// (aggregated host_campaign_clicks rows, mig 594).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-campaign-launch', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolveMissedRecipients: vi.fn() }
})
vi.mock('@/lib/host-campaign-email', () => ({ resolveHostRecipients: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { resolveMissedRecipients } from '@/lib/host-campaign-launch'
import { resolveHostRecipients } from '@/lib/host-campaign-email'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'
const HEALTHY_HOST = { sender_domain_verified: true, sender_email: 'news@runners.ie', postmark_stream_id: 'colm-events' }

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
  let clicksPageIndex = 0
  return (state) => {
    if (state.table === 'rpc' && state.fn === 'host_campaign_stats') {
      return { data: cfg.stats ?? [], error: cfg.statsErr ?? null }
    }
    if (state.table === 'host_campaigns') {
      const campaign = Object.prototype.hasOwnProperty.call(cfg, 'campaign') ? cfg.campaign : DEFAULT_CAMPAIGN
      return { data: campaign, error: null }
    }
    if (state.table === 'event_hosts') {
      if (cfg.hostErr) return { data: null, error: cfg.hostErr }
      return { data: cfg.host === undefined ? HEALTHY_HOST : cfg.host, error: null }
    }
    if (state.table === 'host_campaign_sends') {
      const pages = cfg.pages ?? [[]]
      const page = pages[sendsPageIndex] ?? []
      sendsPageIndex += 1
      return { data: page, error: cfg.sendsErr ?? null }
    }
    if (state.table === 'host_campaign_clicks') {
      if (cfg.clicksErr) return { data: null, error: cfg.clicksErr }
      const pages = cfg.clickPages ?? [[]]
      const page = pages[clicksPageIndex] ?? []
      clicksPageIndex += 1
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
  resolveMissedRecipients.mockResolvedValue({ missed: [], totalRows: 3 })
  resolveHostRecipients.mockResolvedValue([])
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

  it('a stats rpc error still 200s with stats: null — counts unavailable, never confident zeros', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], statsErr: { message: 'rpc broke' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.campaign.stats).toBeNull()
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
    expect(selectArg).not.toContain('postmark_message_id')
    for (const col of [
      'delivered_at', 'opened_at', 'open_count',
      'clicked_at', 'click_count', 'bounced_at', 'bounce_type',
      'complained_at', 'unsubscribed_at', 'failed_reason',
    ]) {
      expect(selectArg).toContain(col)
    }
  })

  it('orders by sent_at desc (nulls last), then email, then id as a final tiebreak', async () => {
    const { db, statements } = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(db)
    await GET(makeRequest(), props)
    const sendStatement = statements.find((s) => s.table === 'host_campaign_sends')
    const orderCalls = sendStatement.ops.filter((o) => o.method === 'order')
    expect(orderCalls[0].args).toEqual(['sent_at', { ascending: false, nullsFirst: false }])
    expect(orderCalls[1].args[0]).toBe('email')
    expect(orderCalls[2].args).toEqual(['id', { ascending: true }])
  })
})

// HOST-RESEND.1 — missed_count / resent_at on the campaign payload.
describe('GET /api/host/emails/[id]/recipients — missed_count (HOST-RESEND.1)', () => {
  it('selects resent_at with the campaign', async () => {
    const { db, statements } = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(db)
    await GET(makeRequest(), props)
    expect(op(statements.find((s) => s.table === 'host_campaigns'), 'select').args[0]).toContain('resent_at')
  })

  it('a sent campaign carries the diff helper\'s missed length, resolved for the session host and this campaign', async () => {
    resolveMissedRecipients.mockResolvedValue({ missed: [{ contact_id: 'x', email: 'x@x.ie' }, { contact_id: 'y', email: 'y@x.ie' }], totalRows: 5 })
    const { db } = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    const body = await res.json()
    expect(body.data.campaign.missed_count).toBe(2)
    expect(resolveMissedRecipients).toHaveBeenCalledWith(db, { hostId: HOST_ID, campaign: expect.objectContaining({ id: CAMPAIGN_ID, audience_kind: 'all' }) })
  })

  it('zero missed is a real 0 (the button hides)', async () => {
    const { db } = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(db)
    expect((await (await GET(makeRequest(), props)).json()).data.campaign.missed_count).toBe(0)
  })

  it('a helper failure gives null, never 0, and still 200s', async () => {
    resolveMissedRecipients.mockRejectedValue(new Error('resolver broke'))
    const { db } = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.campaign.missed_count).toBeNull()
  })

  it('a non-sent campaign never runs the diff and reports null', async () => {
    for (const status of ['draft', 'scheduled', 'sending', 'failed']) {
      vi.clearAllMocks()
      resolveMissedRecipients.mockResolvedValue({ missed: [], totalRows: 3 })
      resolveHostRecipients.mockResolvedValue([])
      getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
      const { db } = makeDb(routeFor({ pages: [[]], campaign: { ...DEFAULT_CAMPAIGN, status } }))
      createServerClient.mockReturnValue(db)
      const res = await GET(makeRequest(), props)
      expect((await res.json()).data.campaign.missed_count).toBeNull()
      expect(resolveMissedRecipients).not.toHaveBeenCalled()
    }
  })
})

// HOST-EMAILS.2 — paused_reason, non_openers_count, links.
describe('GET /api/host/emails/[id]/recipients — HOST-EMAILS.2', () => {
  it('a sending campaign whose host is blocked carries paused_reason; a healthy one carries null', async () => {
    const sendingCampaign = { ...DEFAULT_CAMPAIGN, status: 'sending' }
    const blocked = makeDb(routeFor({ pages: [[]], campaign: sendingCampaign, host: { ...HEALTHY_HOST, sender_domain_verified: false } }))
    createServerClient.mockReturnValue(blocked.db)
    const blockedRes = await GET(makeRequest(), props)
    expect((await blockedRes.json()).data.campaign.paused_reason).toBe('sender_not_verified')

    const healthy = makeDb(routeFor({ pages: [[]], campaign: sendingCampaign }))
    createServerClient.mockReturnValue(healthy.db)
    const healthyRes = await GET(makeRequest(), props)
    expect((await healthyRes.json()).data.campaign.paused_reason).toBeNull()
  })

  it('paused_reason is null for a non-sending campaign even on a blocked host', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], host: { ...HEALTHY_HOST, sender_domain_verified: false } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect((await res.json()).data.campaign.paused_reason).toBeNull()
  })

  it('500s with the db message when the host read fails', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], hostErr: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })

  it('a sent campaign carries non_openers_count from the resolver (null when it throws)', async () => {
    resolveHostRecipients.mockResolvedValue([{ contact_id: 'c1' }, { contact_id: 'c2' }, { contact_id: 'c3' }])
    const { db } = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect((await res.json()).data.campaign.non_openers_count).toBe(3)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, expect.objectContaining({ nonOpenersOf: CAMPAIGN_ID, emailType: 'marketing' }))

    vi.clearAllMocks()
    getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
    resolveMissedRecipients.mockResolvedValue({ missed: [], totalRows: 3 })
    resolveHostRecipients.mockRejectedValue(new Error('resolver broke'))
    const failing = makeDb(routeFor({ pages: [[]] }))
    createServerClient.mockReturnValue(failing.db)
    const failRes = await GET(makeRequest(), props)
    expect(failRes.status).toBe(200)
    expect((await failRes.json()).data.campaign.non_openers_count).toBeNull()
  })

  it('non_openers_count is null for a non-sent campaign and the resolver is never called', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], campaign: { ...DEFAULT_CAMPAIGN, status: 'draft' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect((await res.json()).data.campaign.non_openers_count).toBeNull()
    expect(resolveHostRecipients).not.toHaveBeenCalled()
  })

  it('links: aggregated per url with clicks and people, sorted by clicks desc, unsubscribe link last', async () => {
    const clickRows = [
      { url: 'https://a', contact_id: 'c1', send_id: 's1' },
      { url: 'https://a', contact_id: 'c1', send_id: 's1' },
      { url: 'https://a', contact_id: 'c2', send_id: 's2' },
      { url: 'https://b', contact_id: 'c3', send_id: 's3' },
      { url: 'https://crm/unsubscribe/host/t', contact_id: null, send_id: 's1' },
      { url: 'https://crm/unsubscribe/host/t', contact_id: null, send_id: 's2' },
      { url: 'https://crm/unsubscribe/host/t', contact_id: null, send_id: 's3' },
      { url: 'https://crm/unsubscribe/host/t', contact_id: null, send_id: 's4' },
      { url: 'https://crm/unsubscribe/host/t', contact_id: null, send_id: 's5' },
    ]
    const { db } = makeDb(routeFor({ pages: [[]], clickPages: [clickRows] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.links).toEqual([
      { url: 'https://a', clicks: 3, people: 2, is_unsubscribe: false },
      { url: 'https://b', clicks: 1, people: 1, is_unsubscribe: false },
      { url: 'https://crm/unsubscribe/host/t', clicks: 5, people: 5, is_unsubscribe: true },
    ])
  })

  it('paginates the clicks read past 1000 rows', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ url: 'https://a', contact_id: `c${i}`, send_id: `s${i}` }))
    const lastRow = [{ url: 'https://a', contact_id: 'c1000', send_id: 's1000' }]
    const { db, statements } = makeDb(routeFor({ pages: [[]], clickPages: [fullPage, lastRow] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.links[0]).toEqual({ url: 'https://a', clicks: 1001, people: 1001, is_unsubscribe: false })

    const clickStatements = statements.filter((s) => s.table === 'host_campaign_clicks')
    expect(clickStatements).toHaveLength(2)
    expect(op(clickStatements[0], 'range').args).toEqual([0, 999])
    expect(op(clickStatements[1], 'range').args).toEqual([1000, 1999])
  })

  it('500s with the db message when the clicks read fails', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], clicksErr: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })

  it('an empty click list is an empty links array', async () => {
    const { db } = makeDb(routeFor({ pages: [[]], clickPages: [[]] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(makeRequest(), props)
    expect((await res.json()).data.links).toEqual([])
  })
})
