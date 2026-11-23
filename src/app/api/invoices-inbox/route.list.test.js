// INVSCREEN.1 — which studios the invoices list reads. `location_id=all` is
// every studio the caller may open the inbox for; nothing sent is still the
// active studio only; a named studio is still refused to someone without it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'

const A = 'a0000000-0000-4000-8000-0000000000a1'
const B = 'b0000000-0000-4000-8000-0000000000b2'
const C = 'c0000000-0000-4000-8000-0000000000c3'
let db
let user
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => user) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/permissions', () => ({
  hasPermissionForLocation: (u, id, key) => key === 'invoices_inbox' && (u.inbox || []).includes(id),
}))
vi.mock('@/lib/invoices-queue/queue-preparation', () => ({ queueInvoicePreparation: vi.fn(async () => ({ queued: [] })) }))

const { GET } = await import('./route.js')

const row = (id, location_id, over = {}) => ({ id, location_id, status: 'extracted', source_type: 'supplier_email', received_at: '2026-11-20T10:00:00.000Z', ...over })
const get = (qs = '') => GET(new Request(`http://localhost/api/invoices-inbox${qs}`))
const ids = async (res) => (await res.json()).data.map((r) => r.id).sort()
const loc = (id) => ({ id, name: id.slice(0, 2) })

beforeEach(() => {
  db = createFakeDb({ tables: {
    locations: [{ id: A, name: 'A' }, { id: B, name: 'B' }, { id: C, name: 'C' }],
    invoices_queue: [row('a1', A), row('b1', B), row('c1', C)],
  } })
})

describe('GET /api/invoices-inbox — studio scope', () => {
  it('a master asking for all gets every studio they belong to', async () => {
    user = { id: 'u1', role: 'master', locations: [loc(A), loc(B)], activeLocation: loc(A), inbox: [] }
    expect(await ids(await get('?location_id=all'))).toEqual(['a1', 'b1'])
  })

  it('an owner asking for all gets only the studios whose inbox they may open', async () => {
    user = { id: 'u2', role: 'owner', locations: [loc(A), loc(B), loc(C)], activeLocation: loc(A), inbox: [A, C] }
    expect(await ids(await get('?location_id=all'))).toEqual(['a1', 'c1'])
  })

  it('nothing sent is still the active studio only', async () => {
    user = { id: 'u1', role: 'master', locations: [loc(A), loc(B)], activeLocation: loc(B), inbox: [] }
    expect(await ids(await get())).toEqual(['b1'])
  })

  it('a named studio is refused to someone without its inbox', async () => {
    user = { id: 'u2', role: 'owner', locations: [loc(A), loc(B)], activeLocation: loc(A), inbox: [A] }
    expect((await get(`?location_id=${B}`)).status).toBe(403)
  })

  it('someone with no inbox anywhere is refused before any read', async () => {
    user = { id: 'u3', role: 'staff', locations: [loc(A)], activeLocation: loc(A), inbox: [] }
    expect((await get('?location_id=all')).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('all keeps the status filter', async () => {
    db.tables.invoices_queue.push(row('a2', A, { status: 'forwarded' }))
    user = { id: 'u1', role: 'master', locations: [loc(A), loc(B)], activeLocation: loc(A), inbox: [] }
    expect(await ids(await get('?location_id=all&status=extracted'))).toEqual(['a1', 'b1'])
  })
})
