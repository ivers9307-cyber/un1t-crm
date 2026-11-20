// INVOICES.1 — the stage-1 and stage-2 reject routes through the real withAuth
// wrapper, with loadInvoiceForUser's own gate (owner/master + invoices_inbox
// at the row's studio, 404 otherwise) still deciding.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const quality = await import('./route.js')
const data = await import('../data-reject/route.js')

const INV = 'e0000000-0000-4000-8000-000000000001'
let db
const call = (mod, reason = 'Not an invoice') => mod.POST(
  new Request(`http://localhost/api/invoices-inbox/${INV}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }),
  { params: Promise.resolve({ id: INV }) },
)
const owner = (loc) => person({ [loc]: { role: 'owner', permissions: { invoices_inbox: true } } }, loc)
const seed = (status, location_id = LOC_A) => {
  db = createFakeDb({ tables: {
    locations: [{ id: LOC_A, name: 'A' }, { id: LOC_B, name: 'B' }],
    invoices_queue: [{ id: INV, location_id, status }],
  } })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => { vi.clearAllMocks(); seed('received') })

describe.each([
  ['quality-reject', quality, 'received', 'quality'],
  ['data-reject', data, 'extracted', 'data'],
])('POST /api/invoices-inbox/[id]/%s', (_name, mod, from, stage) => {
  beforeEach(() => seed(from))

  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(mod)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.invoices_queue[0].status).toBe(from)
  })

  it('404 for an owner of another studio', async () => {
    getCurrentUser.mockResolvedValue(owner(LOC_B))
    expect((await call(mod)).status).toBe(404)
    expect(db.tables.invoices_queue[0].status).toBe(from)
  })

  it('404 for a manager with invoices_inbox (the sign-off is owner/master)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { invoices_inbox: true } } }, LOC_A))
    expect((await call(mod)).status).toBe(404)
  })

  it('the owner rejects it, stamped as the caller', async () => {
    getCurrentUser.mockResolvedValue(owner(LOC_A))
    const res = await call(mod)
    expect(res.status).toBe(200)
    expect(db.tables.invoices_queue[0]).toMatchObject({ status: 'rejected', rejected_stage: stage, reject_reason: 'Not an invoice', [`${stage}_reviewed_by`]: 'user-1' })
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.invoices_queue = { update: { message: 'secret detail' } }
    const res = await call(mod)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
