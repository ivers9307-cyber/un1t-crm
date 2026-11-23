// INVOICEPREP.3 — POST /api/invoices-inbox/[id]/data-approve refuses a credit
// note before any write or Xero call: sent as a bill it would be booked the
// wrong way round.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/invoices-queue/push-xero', () => ({ pushQueueRowToXero: vi.fn() }))
vi.mock('@/lib/invoices-queue/push-outcome', () => ({ recordPushOutcome: vi.fn(), rememberSupplierCoding: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { pushQueueRowToXero } = await import('@/lib/invoices-queue/push-xero')
const { recordPushOutcome } = await import('@/lib/invoices-queue/push-outcome')
const { POST } = await import('./route.js')

const INV = 'e2000000-0000-4000-8000-000000000001'
const FIELDS = {
  supplier_name: 'Acme Supplies', invoice_number: 'CN-1', invoice_date: '2026-11-01', currency: 'EUR',
  subtotal: 100, tax_amount: 23, total: 123, tax_type: 'INPUT2', tax_type_source: 'derived',
  xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1', name: 'Acme Supplies' }, xero_account_id: 'a1',
}
const post = () => POST(new Request(`http://localhost/api/invoices-inbox/${INV}/data-approve`, { method: 'POST' }), { params: Promise.resolve({ id: INV }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    locations: [{ id: LOC_A, name: 'A' }],
    invoices_queue: [{ id: INV, location_id: LOC_A, status: 'extracted', extracted_fields: FIELDS, review_reasons: [] }],
  } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { invoices_inbox: true } } }, LOC_A))
  pushQueueRowToXero.mockResolvedValue({ billId: 'b1', billNumber: 'CN-1', deepLinkUrl: 'u', sentTo: 'xero' })
  recordPushOutcome.mockResolvedValue({ outcome: 'ok', row: { id: INV, status: 'forwarded' } })
})

describe('POST /api/invoices-inbox/[id]/data-approve', () => {
  it.each([['extracted'], ['data_approved']])('refuses a credit note from %s with 422, before any write or Xero call', async (status) => {
    Object.assign(db.tables.invoices_queue[0], { status, extracted_fields: { ...FIELDS, document_type: 'credit_note' } })
    const res = await post()
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ success: false, error: 'This is a credit note. It cannot be sent as a bill.' })
    expect(db.tables.invoices_queue[0].status).toBe(status)
    expect(pushQueueRowToXero).not.toHaveBeenCalled()
    expect(db.calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('an invoice is approved and pushed', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(pushQueueRowToXero).toHaveBeenCalledWith(INV)
  })
})
