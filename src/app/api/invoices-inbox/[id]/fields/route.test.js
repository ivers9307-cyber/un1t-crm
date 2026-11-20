// INVOICES.1 — PATCH /api/invoices-inbox/[id]/fields through the real withAuth
// wrapper: signed in, then loadInvoiceForUser's row gate (invoices_inbox and
// owner-or-master at the ROW's studio; 404 otherwise), then the state check.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH } = await import('./route.js')

const MINE = 'e1000000-0000-4000-8000-000000000001'
const THEIRS = 'e1000000-0000-4000-8000-000000000002'
const FIELDS = { supplier_name: 'Acme Supplies', invoice_number: 'INV-1', invoice_date: '2026-11-01', currency: 'EUR', total: 12.5 }
const owner = (role = 'owner') => person({ [LOC_A]: { role, permissions: { invoices_inbox: true } } }, LOC_A)
const patch = (id = MINE, body = { extracted_fields: FIELDS }) => PATCH(new Request(`http://localhost/api/invoices-inbox/${id}/fields`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    locations: [{ id: LOC_A, name: 'Studio A' }, { id: LOC_B, name: 'Studio B' }],
    invoices_queue: [
      { id: MINE, location_id: LOC_A, status: 'extracted', extracted_fields: {} },
      { id: THEIRS, location_id: LOC_B, status: 'extracted', extracted_fields: {} },
    ],
  } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/invoices-inbox/[id]/fields', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await patch()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 for another studio’s invoice, nothing written', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await patch(THEIRS)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
    expect(db.tables.invoices_queue[1].extracted_fields).toEqual({})
  })

  it('404 for a manager at the studio (approval stays an owner decision)', async () => {
    getCurrentUser.mockResolvedValue(owner('manager'))
    expect((await patch()).status).toBe(404)
  })

  it('saves the fields on the owner’s own studio row', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await patch()
    expect(res.status).toBe(200)
    expect(db.tables.invoices_queue[0].extracted_fields.supplier_name).toBe('Acme Supplies')
  })

  it('409 once the row is past review', async () => {
    db.tables.invoices_queue[0].status = 'forwarded'
    getCurrentUser.mockResolvedValue(owner())
    expect((await patch()).status).toBe(409)
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(owner())
    db.errors.invoices_queue = { update: { message: 'deadlock detected on invoices_queue' } }
    const res = await patch()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not save the fields. Try again.' })
  })
})
