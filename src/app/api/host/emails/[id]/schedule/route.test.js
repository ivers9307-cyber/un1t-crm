// src/app/api/host/emails/[id]/schedule/route.test.js
// HOST-SCHEDULE.1 — POST /api/host/emails/[id]/schedule { scheduled_for }.
// Host session; the campaign must be the session host's (404, no
// enumeration). The window (≥15 min, ≤90 days) is validateScheduledFor's.
// Early feedback gates (sender verified, stream for marketing) run here;
// the cap and recipients do NOT (they change by fire time). CAS from
// draft OR scheduled → scheduled (reschedule is the same call), clearing
// schedule_error; a sending/sent campaign 409s.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'
const HOST_ROW = { id: HOST_ID, sender_domain_verified: true, sender_email: 'news@runners.ie', postmark_stream_id: 'colm-events' }
const IN_30_MIN = () => new Date(Date.now() + 30 * 60_000).toISOString()

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
      if (first.method === 'select') return { data: cfg.campaign === undefined ? { id: CAMPAIGN_ID, status: 'draft', email_type: 'marketing' } : cfg.campaign, error: null }
      if (first.method === 'update') return { data: cfg.casRows ?? [{ id: CAMPAIGN_ID, status: 'scheduled', scheduled_for: cfg.echo ?? null, schedule_error: null }], error: cfg.updateErr ?? null }
    }
    if (state.table === 'event_hosts') return { data: cfg.host === undefined ? HOST_ROW : cfg.host, error: null }
    return {}
  }
}

const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }
function req(body) {
  return new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('POST /api/host/emails/[id]/schedule', () => {
  it('401s without a host session and touches no table', async () => {
    getCurrentHost.mockResolvedValue(null)
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(401)
    expect(statements).toHaveLength(0)
  })

  it('400s on invalid JSON, a missing field, a non-date, too soon, too far', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    expect((await POST(req('{nope'), props)).status).toBe(400)
    expect((await POST(req({}), props)).status).toBe(400)
    expect((await POST(req({ scheduled_for: 'tomorrow' }), props)).status).toBe(400)
    const soon = await POST(req({ scheduled_for: new Date(Date.now() + 5 * 60_000).toISOString() }), props)
    expect(soon.status).toBe(400)
    expect((await soon.json()).error).toBe('Pick a time at least 15 minutes from now.')
    const far = await POST(req({ scheduled_for: new Date(Date.now() + 91 * 24 * 3600_000).toISOString() }), props)
    expect(far.status).toBe(400)
    expect((await far.json()).error).toBe('Pick a time within the next 90 days.')
  })

  it("404s another host's campaign (tenancy via .eq('host_id'))", async () => {
    const { db, statements } = makeDb(routeFor({ campaign: null }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(404)
    const read = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(read, 'host_id', HOST_ID)).toBe(true)
  })

  it('409s a campaign that is sending or sent, before any gate or write', async () => {
    const { db, statements } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'sent', email_type: 'marketing' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(409)
    expect(statements.some((s) => op(s, 'update'))).toBe(false)
  })

  it('409s when the sender is unverified (early feedback for the kill switch)', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, sender_domain_verified: false } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/not enabled/)
  })

  it('409s a marketing campaign with no host stream; utility passes', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null } }))
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ scheduled_for: IN_30_MIN() }), props)).status).toBe(409)
    const u = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility' } }))
    createServerClient.mockReturnValue(u.db)
    expect((await POST(req({ scheduled_for: IN_30_MIN() }), props)).status).toBe(200)
  })

  it('CAS from draft or scheduled → scheduled, stamps the normalised time, clears schedule_error, returns the row', async () => {
    const when = IN_30_MIN()
    const { db, statements } = makeDb(routeFor({ echo: when }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: when }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.status).toBe('scheduled')

    const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(cas, 'update').args[0]).toEqual({ status: 'scheduled', scheduled_for: when, schedule_error: null })
    expect(hasEq(cas, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(cas, 'host_id', HOST_ID)).toBe(true)
    const inOp = op(cas, 'in')
    expect(inOp.args[0]).toBe('status')
    expect(inOp.args[1]).toEqual(['draft', 'scheduled'])
  })

  it('reschedules an already scheduled campaign through the same CAS (Change time)', async () => {
    const when = IN_30_MIN()
    const { db, statements } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'scheduled', email_type: 'marketing' }, echo: when }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: when }), props)
    expect(res.status).toBe(200)
    const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(cas, 'update').args[0]).toEqual({ status: 'scheduled', scheduled_for: when, schedule_error: null })
  })

  it('never evaluates the daily cap or the recipient list at schedule time (both are fire-time gates)', async () => {
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ scheduled_for: IN_30_MIN() }), props)).status).toBe(200)
    // Exactly: campaign read, host read, CAS update. No head-count query, no
    // host_campaign_sends / host_contacts touch, no resolver.
    expect(statements.map((s) => `${s.table}:${s.ops[0].method}`)).toEqual([
      'host_campaigns:select',
      'event_hosts:select',
      'host_campaigns:update',
    ])
    expect(statements.some((s) => s.ops.some((o) => o.method === 'select' && o.args[1]?.head))).toBe(false)
  })

  it('409s when the CAS matches no row (it fired or was sent meanwhile)', async () => {
    const { db } = makeDb(routeFor({ casRows: [] }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(409)
  })

  it('500s with the db message when the update fails', async () => {
    const { db } = makeDb(routeFor({ updateErr: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })
})
