// INVOICEPREP.3 — POST /api/invoices-inbox/[id]/restore through the real
// withAuth wrapper: a set-aside (not_invoice) row goes back to received and
// onto the preparation queue. Every refusal of the caller is a 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/invoices-queue/queue-preparation', () => ({ queueInvoicePreparation: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { queueInvoicePreparation } = await import('@/lib/invoices-queue/queue-preparation')
const { POST } = await import('./route.js')

const INV = 'c3000000-0000-4000-8000-000000000001'
const INV_B = 'c3000000-0000-4000-8000-000000000002'
const OTHER = 'c3000000-0000-4000-8000-000000000003'
const row = (extra = {}) => ({
  id: INV, location_id: LOC_A, status: 'not_invoice',
  attachment_bucket: 'inbound-invoices', attachment_path: 'inv/one.pdf',
  not_invoice_reason: 'not_an_invoice', review_reasons: ['duplicate_file'],
  prepared_at: '2026-11-20T10:00:00.000Z', duplicate_of_id: OTHER, extraction_error: 'x',
  analysis_claimed_at: '2026-11-20T10:00:00.000Z',
  ...extra,
})
const post = (id = INV) => POST(new Request(`http://localhost/api/invoices-inbox/${id}/restore`, { method: 'POST' }), { params: Promise.resolve({ id }) })
let db
const mine = () => db.tables.invoices_queue[0]

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    invoices_queue: [row(), row({ id: INV_B, location_id: LOC_B }), row({ id: OTHER, status: 'extracted', duplicate_of_id: null })],
    locations: [{ id: LOC_A, name: 'A' }, { id: LOC_B, name: 'B' }],
  } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
  queueInvoicePreparation.mockResolvedValue({ queued: [INV] })
})

describe('POST /api/invoices-inbox/[id]/restore', () => {
  it('brings a set-aside row back to received, clears what preparation left, and queues it', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { id: INV, status: 'received' } })
    expect(mine()).toMatchObject({
      status: 'received', not_invoice_reason: null, review_reasons: [], prepared_at: null,
      duplicate_of_id: null, extraction_error: null, analysis_claimed_at: null,
    })
    expect(queueInvoicePreparation).toHaveBeenCalledWith(db, [INV])
  })

  it('400 for a row with no file, nothing changed', async () => {
    mine().attachment_path = null
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'This row has no attachment to read.' })
    expect(mine().status).toBe('not_invoice')
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })

  it('409 from any other status', async () => {
    mine().status = 'extracted'
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: "Cannot restore from 'extracted' state." })
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })

  it('404 for another studio’s row, nothing changed', async () => {
    const res = await post(INV_B)
    expect(res.status).toBe(404)
    expect(db.tables.invoices_queue[1].status).toBe('not_invoice')
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })

  it('404 for a manager at the studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { invoices_inbox: true } } }, LOC_A))
    expect((await post()).status).toBe(404)
    expect(mine().status).toBe('not_invoice')
  })

  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })

  it('a failing queue call is logged and the restore still stands', async () => {
    queueInvoicePreparation.mockRejectedValueOnce(new Error('down'))
    const res = await post()
    expect(res.status).toBe(200)
    expect(mine().status).toBe('received')
    expect(logError).toHaveBeenCalled()
  })

  it('a failed write answers a fixed 500', async () => {
    db.errors.invoices_queue = { update: { message: 'deadlock detected on invoices_queue' } }
    const res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/invoices_queue/)
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })
})
