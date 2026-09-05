// Resolve/acknowledge route for webhook_dead_letter rows (DEADLETTER-UI.1).
//
// The property that matters: this is the ONLY write the route performs —
// status + resolved_at. No replay, no processing. Most email-family rows are
// deliberately non-replayable (a replay of a sent email IS the double-send),
// so a human acknowledgement must exist and must stamp resolved_at, which is
// what the integration-health backlog count keys on.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let rowResult = { data: null, error: null }
let updateResult = { error: null }
let updates = []

function makeBuilder() {
  const b = { _filters: [] }
  b.select = () => b
  b.eq = (col, val) => { b._filters.push([col, val]); return b }
  b.single = () => Promise.resolve(rowResult)
  b.update = (payload) => {
    const u = {
      eq: (col, val) => {
        updates.push({ payload, id: val })
        return Promise.resolve(updateResult)
      },
    }
    return u
  }
  return b
}
const fakeDb = { from: vi.fn(() => makeBuilder()) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const MASTER = { id: 'prof-1', profileRole: 'master', role: 'staff' }
const OWNER = { id: 'prof-2', profileRole: 'user', role: 'owner' }
const MANAGER = { id: 'prof-3', profileRole: 'user', role: 'manager' }

function req(body) {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return body
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  rowResult = { data: { id: 7, status: 'pending' }, error: null }
  updateResult = { error: null }
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('POST /api/admin/webhook-dead-letter/[id]/resolve', () => {
  it('marks a pending row resolved and stamps resolved_at', async () => {
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: 7, status: 'resolved' } })
    expect(updates).toHaveLength(1)
    expect(updates[0].payload.status).toBe('resolved')
    // resolved_at is what the integration-health count keys on — a row
    // acknowledged without it would keep nagging forever.
    expect(typeof updates[0].payload.resolved_at).toBe('string')
    expect(Object.keys(updates[0].payload).sort()).toEqual(['resolved_at', 'status'])
  })

  it('discard also stamps resolved_at (same effect on the health count)', async () => {
    const res = await POST(req({ status: 'discarded' }), { params: { id: '7' } })
    expect(res.status).toBe(200)
    expect(updates[0].payload.status).toBe('discarded')
    expect(typeof updates[0].payload.resolved_at).toBe('string')
  })

  it('defaults to resolved when the body is empty or absent', async () => {
    const res = await POST(req(undefined), { params: { id: '7' } })
    expect(res.status).toBe(200)
    expect(updates[0].payload.status).toBe('resolved')
  })

  it('acknowledges failed rows too (replay gave up; a human still must)', async () => {
    rowResult = { data: { id: 7, status: 'failed' }, error: null }
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(200)
  })

  it('rejects any other target status — no path back to pending, no processing', async () => {
    const res = await POST(req({ status: 'pending' }), { params: { id: '7' } })
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it('409s an already-terminal row instead of double-stamping it', async () => {
    rowResult = { data: { id: 7, status: 'resolved' }, error: null }
    const res = await POST(req({}), { params: { id: '7' } })
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('404s a missing row', async () => {
    rowResult = { data: null, error: { message: 'not found' } }
    const res = await POST(req({}), { params: { id: '999' } })
    expect(res.status).toBe(404)
  })

  it('reads the id off a PROMISE params — what Next 16 actually hands a route handler', async () => {
    // MAIL-DEADLETTER.1 — `const { id } = params` on a Promise is undefined,
    // so every Resolve/Discard click 400'd "Missing id" in production while
    // this file, passing a plain object, stayed green. Both shapes must work.
    const res = await POST(req({}), { params: Promise.resolve({ id: '7' }) })
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('7')
  })

  it('owner passes, manager and anonymous do not', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    expect((await POST(req({}), { params: { id: '7' } })).status).toBe(200)

    getCurrentUser.mockResolvedValue(MANAGER)
    expect((await POST(req({}), { params: { id: '7' } })).status).toBe(403)

    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({}), { params: { id: '7' } })).status).toBe(401)
  })
})
