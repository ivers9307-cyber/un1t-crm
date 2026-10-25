// HOST-CONSENT.1 — PATCH /api/hosts/[id] schema coverage for
// postmark_stream_id, run through the real handler (validateBody + the
// zod schema live in route.js, not re-implemented here).
//
// The regex alone would accept 'broadcast' — it's shaped like a valid
// stream id. RESERVED_POSTMARK_STREAMS + the .refine() reject it because
// typing it into the admin field would silently put the host back on
// UN1T's shared marketing stream (the coupling mig 588 removed). Belt:
// supabase/migrations/589_host_stream_reserved_ids.sql enforces the same
// set at the DB layer.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/hosts', async (orig) => ({ ...(await orig()), loadHostForOrg: vi.fn() }))

import { PATCH, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostForOrg } from '@/lib/hosts'

const HOST_ID = 'h-1'
const ORG_ID = 'org-1'

// ── chainable fake, modeled on src/app/api/host/emails/[id]/send/route.test.js ──
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

// event_hosts.update(...) echoes back the written fields as the "row" —
// simplest way to assert on what the route actually persisted.
function routeFor() {
  return (state) => {
    if (state.table === 'event_hosts') {
      const updateOp = op(state, 'update')
      return { data: { id: HOST_ID, ...updateOp.args[0] }, error: null }
    }
    return {}
  }
}

function makeRequest(body) {
  return new Request(`http://localhost/api/hosts/${HOST_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const props = { params: Promise.resolve({ id: HOST_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ role: 'manager', activeOrganization: { id: ORG_ID } })
  loadHostForOrg.mockResolvedValue({ id: HOST_ID, organization_id: ORG_ID })
})

describe('PATCH /api/hosts/[id] — postmark_stream_id', () => {
  it('accepts a valid host-owned stream id', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await PATCH(makeRequest({ postmark_stream_id: 'colm-events' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.postmark_stream_id).toBe('colm-events')
  })

  it('trims surrounding whitespace before storing', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await PATCH(makeRequest({ postmark_stream_id: ' colm-events ' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.postmark_stream_id).toBe('colm-events')
  })

  it('rejects an id with uppercase characters', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await PATCH(makeRequest({ postmark_stream_id: 'Colm-Events' }), props)
    expect(res.status).toBe(400)
  })

  it("rejects Postmark's shared 'broadcast' stream with an explanatory message", async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await PATCH(makeRequest({ postmark_stream_id: 'broadcast' }), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.issues?.[0]?.message).toMatch(/shared/)
  })

  it("rejects the reserved 'outbound' and 'inbound' stream ids too", async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    for (const reserved of ['outbound', 'inbound']) {
      const res = await PATCH(makeRequest({ postmark_stream_id: reserved }), props)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.issues?.[0]?.message).toMatch(/shared/)
    }
  })

  it('an empty string clears the stream id (stored as null — sends fail closed)', async () => {
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await PATCH(makeRequest({ postmark_stream_id: '' }), props)
    expect(res.status).toBe(200)
    const updateOp = op(statements[0], 'update')
    expect(updateOp.args[0].postmark_stream_id).toBeNull()
  })

  it('an explicit null clears the stream id', async () => {
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await PATCH(makeRequest({ postmark_stream_id: null }), props)
    expect(res.status).toBe(200)
    const updateOp = op(statements[0], 'update')
    expect(updateOp.args[0].postmark_stream_id).toBeNull()
  })

  it('an empty body 400s with "No fields to update"', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await PATCH(makeRequest({}), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.issues?.[0]?.message).toBe('No fields to update')
  })
})

// HOST-EMAILS.2 — a host that has sent email is kept: mig 772's trigger
// refuses to delete a sent campaign, and host_campaigns cascades from the host.
describe('DELETE /api/hosts/[id] — a host with sent email is kept', () => {
  const del = () => DELETE(new Request(`http://localhost/api/hosts/${HOST_ID}`, { method: 'DELETE' }), props)
  const route = ({ sent = 0, countError = null, deleteError = null } = {}) => (state) => {
    if (state.table === 'host_campaigns') return { count: sent, error: countError }
    if (state.table === 'event_hosts' && op(state, 'delete')) return { error: deleteError }
    return {}
  }

  it('409s, and deletes nothing, when any campaign is past scheduled', async () => {
    const { db, statements } = makeDb(route({ sent: 2 }))
    createServerClient.mockReturnValue(db)
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/has sent emails/)
    expect(statements.some((s) => s.table === 'event_hosts' && op(s, 'delete'))).toBe(false)
    const read = statements.find((s) => s.table === 'host_campaigns')
    expect(op(read, 'eq').args).toEqual(['host_id', HOST_ID])
    expect(op(read, 'not').args).toEqual(['status', 'in', '(draft,scheduled)'])
  })

  it('deletes a host whose campaigns are all drafts or scheduled', async () => {
    const { db, statements } = makeDb(route({ sent: 0 }))
    createServerClient.mockReturnValue(db)
    const res = await del()
    expect(res.status).toBe(200)
    expect(statements.some((s) => s.table === 'event_hosts' && op(s, 'delete'))).toBe(true)
  })

  it('maps the trigger refusal (a send started after the read) to the same 409', async () => {
    const { db } = makeDb(route({ deleteError: { code: '23514', message: 'Host campaign x is sending and cannot be deleted.' } }))
    createServerClient.mockReturnValue(db)
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/has sent emails/)
  })

  it('500s when the campaign read fails, rather than guessing', async () => {
    const { db, statements } = makeDb(route({ countError: { message: 'down' } }))
    createServerClient.mockReturnValue(db)
    const res = await del()
    expect(res.status).toBe(500)
    expect(statements.some((s) => s.table === 'event_hosts' && op(s, 'delete'))).toBe(false)
  })
})
