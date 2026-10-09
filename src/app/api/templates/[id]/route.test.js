// W0.11 — /api/templates/[id]: a template with no location belongs to the
// platform, not to any tenant, and is master-only.
//
// assertLocationAccessOr404 passes a NULL location through (nothing to judge
// at) and the per-location `email` check was skipped for it, so any staff
// member of any tenant who held `email` somewhere could read a platform
// template by id. Non-masters get the same 404 as a missing id, so the id is
// never confirmed; located templates keep their existing rule.
//
// Same pattern as src/app/api/orders/[id]/route.test.js: hoisted vi.mock for
// auth (faithful assertLocationAccessOr404 reimplementation) + supabase, then
// call the handler with a fabricated Request + { params }. Permissions are
// REAL: "holds `email` somewhere" is the rule under test, not a stub.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

import { GET, PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// ─── Recording fake ──────────────────────────────────────────────
//
// Every chain the route builds is recorded as one op:
//   { table, action, eq, terminal, payload }
// so a test can assert what was (and was NOT) written, not just what came
// back. `rows` is the table by id; a select answers from it, an update merges
// into a copy, a delete answers { error: null }.
function fakeDb(rows) {
  const ops = []
  function from(table) {
    const op = { table, action: null, eq: {}, terminal: null, payload: null }
    ops.push(op)
    const run = () => {
      const row = rows[op.eq.id] || null
      if (op.action === 'select') {
        return row
          ? { data: row, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
      }
      if (op.action === 'update') return { data: { ...row, ...op.payload }, error: null }
      if (op.action === 'delete') return { data: null, error: null }
      throw new Error(`fakeDb: unexpected action ${op.action}`)
    }
    const chain = {
      select() { if (!op.action) op.action = 'select'; return chain },
      update(payload) { op.action = 'update'; op.payload = payload; return chain },
      delete() { op.action = 'delete'; return chain },
      eq(col, val) { op.eq[col] = val; return chain },
      single() { op.terminal = 'single'; return Promise.resolve(run()) },
      // DELETE awaits the builder itself (no terminal).
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    return chain
  }
  return { db: { from }, ops }
}

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111'
const LOCATED_ID  = '22222222-2222-4222-8222-222222222222'
const MISSING_ID  = '33333333-3333-4333-8333-333333333333'

const ROWS = {
  [PLATFORM_ID]: { id: PLATFORM_ID, name: 'Platform welcome', location_id: null, html_content: '<p>platform</p>' },
  [LOCATED_ID]:  { id: LOCATED_ID,  name: 'Studio welcome',   location_id: 'loc-mine', html_content: '<p>studio</p>' },
}

// A non-master who holds `email` somewhere: owners hold `email` by default
// (same user shape as the editor page test).
const owner = {
  id: 'user-owner',
  role: 'owner',
  profileRole: 'owner',
  isMaster: false,
  locations: [{ id: 'loc-mine', role: 'owner', features: {} }],
  assignmentsByLocation: { 'loc-mine': { role: 'owner', permissions: {} } },
  activeLocation: { id: 'loc-mine', features: {} },
}

const master = {
  id: 'user-master',
  role: 'master',
  profileRole: 'master',
  isMaster: true,
  locations: [{ id: 'loc-mine', role: 'master', features: {} }],
  assignmentsByLocation: { 'loc-mine': { role: 'master', permissions: {} } },
  activeLocation: { id: 'loc-mine', features: {} },
}

const props = (id) => ({ params: Promise.resolve({ id }) })
const req = (body = {}) => new Request('http://localhost/api/templates/x', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const writes = (ops) => ops.filter((o) => o.action === 'update' || o.action === 'delete')

beforeEach(() => vi.clearAllMocks())

describe('/api/templates/[id] — a location-less (platform) template is master-only', () => {
  it('GET: a non-master who holds email somewhere gets the missing-id 404, not the row', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const { db } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await GET(new Request('http://localhost'), props(PLATFORM_ID))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Template not found' })
  })

  it('PUT: a non-master gets 404 and NO update is written', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const { db, ops } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ name: 'hijacked' }), props(PLATFORM_ID))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Template not found' })
    expect(writes(ops)).toEqual([])
  })

  it('DELETE: a non-master gets 404 and NO delete is issued', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const { db, ops } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await DELETE(new Request('http://localhost', { method: 'DELETE' }), props(PLATFORM_ID))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Template not found' })
    expect(writes(ops)).toEqual([])
  })

  it('GET: a master reads the platform template', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await GET(new Request('http://localhost'), props(PLATFORM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.template).toEqual(ROWS[PLATFORM_ID])
  })

  it('PUT: a master edits the platform template (the update is written)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, ops } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ name: 'Platform welcome v2' }), props(PLATFORM_ID))
    expect(res.status).toBe(200)
    expect(writes(ops)).toEqual([
      expect.objectContaining({ table: 'email_templates', action: 'update', eq: { id: PLATFORM_ID }, payload: { name: 'Platform welcome v2' } }),
    ])
  })

  it('DELETE: a master deletes the platform template (the delete is issued)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, ops } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await DELETE(new Request('http://localhost', { method: 'DELETE' }), props(PLATFORM_ID))
    expect(res.status).toBe(200)
    expect(writes(ops)).toEqual([
      expect.objectContaining({ table: 'email_templates', action: 'delete', eq: { id: PLATFORM_ID } }),
    ])
  })
})

describe('/api/templates/[id] — unchanged behaviour', () => {
  it('GET: a located template at a studio the user can access is served (positive control)', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const { db } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await GET(new Request('http://localhost'), props(LOCATED_ID))
    expect(res.status).toBe(200)
    expect((await res.json()).template).toEqual(ROWS[LOCATED_ID])
  })

  it('PUT: a missing id is still "Template not found" before any guard, for a master too', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, ops } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ name: 'x' }), props(MISSING_ID))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Template not found' })
    expect(writes(ops)).toEqual([])
  })

  it('DELETE: a missing id is still "Template not found", for a master too', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, ops } = fakeDb(ROWS)
    createServerClient.mockReturnValue(db)
    const res = await DELETE(new Request('http://localhost', { method: 'DELETE' }), props(MISSING_ID))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Template not found' })
    expect(writes(ops)).toEqual([])
  })
})
