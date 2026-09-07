// src/app/api/host/emails/[id]/reminder-draft/route.test.js
// POST /api/host/emails/[id]/reminder-draft — HOST-EMAILS.2. A new draft
// "Reminder: <subject>" with audience non_openers pointing at the parent;
// the parent must be sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { HOST_CAMPAIGN_LIST_COLUMNS } from '@/lib/host-campaign-draft'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'
const NEW_ID = 'a0000000-0000-0000-0000-0000000000a2'

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

const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }
function req() {
  return new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/reminder-draft`, { method: 'POST' })
}

const PARENT = {
  id: CAMPAIGN_ID, subject: 'Race week', body_html: '<p>x</p>', design_json: { a: 1 },
  email_type: 'marketing', status: 'sent',
}

function routeFor(cfg = {}) {
  return (state) => {
    if (state.table === 'host_campaigns') {
      if (op(state, 'insert')) {
        if (cfg.insertErr) return { data: null, error: cfg.insertErr }
        return { data: cfg.inserted ?? { id: NEW_ID, subject: 'Reminder: Race week', status: 'draft' }, error: null }
      }
      if (op(state, 'select')) {
        if (cfg.readErr) return { data: null, error: cfg.readErr }
        return { data: cfg.parent === undefined ? PARENT : cfg.parent, error: null }
      }
    }
    return {}
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('POST /api/host/emails/[id]/reminder-draft', () => {
  it('401s without a session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(401)
  })

  it('creates "Reminder: <subject>" with audience non_openers pointing at the parent; parent must be sent', async () => {
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    const ins = statements.find((s) => s.table === 'host_campaigns' && op(s, 'insert'))
    expect(op(ins, 'insert').args[0]).toEqual({
      host_id: HOST_ID, subject: 'Reminder: Race week', body_html: '<p>x</p>', design_json: { a: 1 },
      audience_kind: 'non_openers', audience_campaign_id: CAMPAIGN_ID, audience_event_id: null,
      status: 'draft', email_type: 'marketing',
    })
  })

  it('selects HOST_CAMPAIGN_LIST_COLUMNS on the insert and returns exactly the row the db handed back', async () => {
    const inserted = { id: NEW_ID, subject: 'Reminder: Race week', status: 'draft', audience_campaign_id: CAMPAIGN_ID }
    const { db, statements } = makeDb(routeFor({ inserted }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    const ins = statements.find((s) => s.table === 'host_campaigns' && op(s, 'insert'))
    expect(op(ins, 'select').args[0]).toEqual(HOST_CAMPAIGN_LIST_COLUMNS)
    expect((await res.json()).data).toEqual(inserted)
  })

  it('reads scoped by host_id + id', async () => {
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    await POST(req(), props)
    const read = statements.find((s) => s.table === 'host_campaigns' && op(s, 'select'))
    expect(hasEq(read, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(read, 'host_id', HOST_ID)).toBe(true)
  })

  it("404s for another host's campaign", async () => {
    const { db } = makeDb(routeFor({ parent: null }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(404)
  })

  it("409s 'Only a sent email can have a reminder.' for a draft parent", async () => {
    const { db } = makeDb(routeFor({ parent: { ...PARENT, status: 'draft' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Only a sent email can have a reminder.')
  })

  it('500s on a read error', async () => {
    const { db } = makeDb(routeFor({ readErr: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })

  it('500s on an insert error', async () => {
    const { db } = makeDb(routeFor({ insertErr: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })
})
