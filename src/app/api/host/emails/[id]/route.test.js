// src/app/api/host/emails/[id]/route.test.js
// HOST-EMAIL.4 GET/PATCH one host campaign; HOST-EMAILS.2 adds DELETE and a
// 'non_openers' audience on PATCH. Tenancy throughout: every query
// .eq('host_id', session.host.id) → 404, not 403 (ids stay un-enumerable).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, PATCH, DELETE } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'
const PARENT_ID = 'a0000000-0000-0000-0000-0000000000a2'
const EVENT_ID = 'c0000000-0000-0000-0000-0000000000c1'

// ── chainable Proxy fake, copied from schedule/route.test.js ──────────────
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
function req(method, body) {
  return new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('GET /api/host/emails/[id]', () => {
  it('401s without a session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await GET(req('GET'), props)
    expect(res.status).toBe(401)
  })

  it('404s when not found (or not this host\'s), scoping by host_id and id', async () => {
    const { db, statements } = makeDb(() => ({ data: null, error: null }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req('GET'), props)
    expect(res.status).toBe(404)
    const read = statements[0]
    expect(hasEq(read, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(read, 'host_id', HOST_ID)).toBe(true)
  })

  it('500s with the db message on a read error', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req('GET'), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })

  it('200s with the full draft row', async () => {
    const row = { id: CAMPAIGN_ID, subject: 'Race week', body_html: '<p>x</p>', status: 'draft' }
    const { db } = makeDb(() => ({ data: row, error: null }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req('GET'), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(row)
  })

  // HOST-EMAILS.2 review fix — the select had omitted audience_campaign_id,
  // so a 'non_openers' draft round-tripped into the composer with it
  // undefined and a save silently turned the reminder into an all-contacts
  // send.
  it('selects audience_campaign_id, and a non_openers row carries it in the response', async () => {
    const row = {
      id: CAMPAIGN_ID, subject: 'Reminder: Race week', body_html: '<p>x</p>', status: 'draft',
      audience_kind: 'non_openers', audience_campaign_id: PARENT_ID,
    }
    const { db, statements } = makeDb(() => ({ data: row, error: null }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req('GET'), props)
    expect(res.status).toBe(200)
    const read = statements[0]
    expect(op(read, 'select').args[0]).toContain('audience_campaign_id')
    expect((await res.json()).data.audience_campaign_id).toBe(PARENT_ID)
  })
})

describe('PATCH /api/host/emails/[id]', () => {
  it('401s without a session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await PATCH(req('PATCH', { subject: 'x', body: 'y' }), props)
    expect(res.status).toBe(401)
  })

  it('400s on invalid JSON', async () => {
    const res = await PATCH(req('PATCH', '{nope'), props)
    expect(res.status).toBe(400)
  })

  it('400s on a missing field', async () => {
    const res = await PATCH(req('PATCH', {}), props)
    expect(res.status).toBe(400)
  })

  it('CAS-updates a draft, defaulting audience to all and clearing audience_campaign_id', async () => {
    const { db, statements } = makeDb((state) => {
      if (state.table === 'host_campaigns' && op(state, 'update')) return { data: [{ id: CAMPAIGN_ID }], error: null }
      return {}
    })
    createServerClient.mockReturnValue(db)
    const res = await PATCH(req('PATCH', { subject: 'Race week', body: '<p>x</p>' }), props)
    expect(res.status).toBe(200)
    const upd = statements.find((s) => op(s, 'update'))
    expect(op(upd, 'update').args[0]).toEqual({
      subject: 'Race week', body_html: '<p>x</p>', design_json: null,
      audience_kind: 'all', audience_event_id: null, audience_campaign_id: null,
      email_type: 'marketing',
    })
    expect(hasEq(upd, 'status', 'draft')).toBe(true)
  })

  it('409s when nothing matched (no longer a draft)', async () => {
    const { db } = makeDb((state) => {
      if (state.table === 'host_campaigns' && op(state, 'update')) return { data: [], error: null }
      return {}
    })
    createServerClient.mockReturnValue(db)
    const res = await PATCH(req('PATCH', { subject: 'x', body: 'y' }), props)
    expect(res.status).toBe(409)
  })

  it('500s with the db message when the update errors', async () => {
    const { db } = makeDb((state) => {
      if (state.table === 'host_campaigns' && op(state, 'update')) return { data: null, error: { message: 'kaboom' } }
      return {}
    })
    createServerClient.mockReturnValue(db)
    const res = await PATCH(req('PATCH', { subject: 'x', body: 'y' }), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })

  it('400s an event audience with no event id', async () => {
    const { db } = makeDb(() => ({}))
    createServerClient.mockReturnValue(db)
    const res = await PATCH(req('PATCH', { subject: 'x', body: 'y', audience_kind: 'event' }), props)
    expect(res.status).toBe(400)
  })

  it('404s an event not owned by this host', async () => {
    const { db } = makeDb((state) => {
      if (state.table === 'race_events') return { data: null, error: null }
      return {}
    })
    createServerClient.mockReturnValue(db)
    const res = await PATCH(req('PATCH', { subject: 'x', body: 'y', audience_kind: 'event', audience_event_id: EVENT_ID }), props)
    expect(res.status).toBe(404)
  })

  describe('audience_kind non_openers (HOST-EMAILS.2)', () => {
    it("400s 'This reminder has no parent email.' when audience_campaign_id is missing", async () => {
      const { db } = makeDb(() => ({}))
      createServerClient.mockReturnValue(db)
      const res = await PATCH(req('PATCH', { subject: 'Reminder', body: '<p>x</p>', audience_kind: 'non_openers' }), props)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('This reminder has no parent email.')
    })

    it('writes audience_kind + audience_campaign_id when the parent is owned by this host', async () => {
      const { db, statements } = makeDb((state) => {
        if (state.table === 'host_campaigns' && op(state, 'select')) return { data: { id: PARENT_ID }, error: null }
        if (state.table === 'host_campaigns' && op(state, 'update')) return { data: [{ id: CAMPAIGN_ID }], error: null }
        return {}
      })
      createServerClient.mockReturnValue(db)
      const res = await PATCH(
        req('PATCH', { subject: 'Reminder: Race week', body: '<p>x</p>', audience_kind: 'non_openers', audience_campaign_id: PARENT_ID }),
        props,
      )
      expect(res.status).toBe(200)
      const parentRead = statements.find((s) => op(s, 'select'))
      expect(hasEq(parentRead, 'id', PARENT_ID)).toBe(true)
      expect(hasEq(parentRead, 'host_id', HOST_ID)).toBe(true)
      const upd = statements.find((s) => op(s, 'update'))
      expect(op(upd, 'update').args[0]).toMatchObject({ audience_kind: 'non_openers', audience_campaign_id: PARENT_ID, audience_event_id: null })
    })

    it("404s 'Parent email not found.' when the parent isn't this host's", async () => {
      const { db } = makeDb((state) => {
        if (state.table === 'host_campaigns' && op(state, 'select')) return { data: null, error: null }
        return {}
      })
      createServerClient.mockReturnValue(db)
      const res = await PATCH(
        req('PATCH', { subject: 'Reminder', body: '<p>x</p>', audience_kind: 'non_openers', audience_campaign_id: PARENT_ID }),
        props,
      )
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe('Parent email not found.')
    })

    it('500s with the db message when the parent read errors', async () => {
      const { db } = makeDb((state) => {
        if (state.table === 'host_campaigns' && op(state, 'select')) return { data: null, error: { message: 'kaboom' } }
        return {}
      })
      createServerClient.mockReturnValue(db)
      const res = await PATCH(
        req('PATCH', { subject: 'Reminder', body: '<p>x</p>', audience_kind: 'non_openers', audience_campaign_id: PARENT_ID }),
        props,
      )
      expect(res.status).toBe(500)
      expect((await res.json()).error).toBe('kaboom')
    })
  })
})

describe('DELETE /api/host/emails/[id] (HOST-EMAILS.2)', () => {
  it('401 without a session', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await DELETE(req('DELETE'), props)
    expect(res.status).toBe(401)
  })

  it('deletes a draft or scheduled campaign of this host (CAS on status) and returns its id', async () => {
    const { db, statements } = makeDb(() => ({ data: [{ id: CAMPAIGN_ID }], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await DELETE(req('DELETE'), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ id: CAMPAIGN_ID })
    const del = statements.find((s) => s.table === 'host_campaigns')
    expect(op(del, 'delete')).toBeTruthy()
    expect(hasEq(del, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(del, 'host_id', HOST_ID)).toBe(true)
    expect(op(del, 'in').args).toEqual(['status', ['draft', 'scheduled']])
  })

  it("409s \"Sent emails can't be deleted. They are the record of what went out.\" when nothing matched", async () => {
    const { db } = makeDb(() => ({ data: [], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await DELETE(req('DELETE'), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("Sent emails can't be deleted. They are the record of what went out.")
  })

  it('500 with the message on a db error', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await DELETE(req('DELETE'), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })
})
