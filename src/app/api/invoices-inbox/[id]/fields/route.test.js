// INVOICES.1 — PATCH /api/invoices-inbox/[id]/fields through the real withAuth
// wrapper: signed in, then loadInvoiceForUser's row gate (invoices_inbox and
// owner-or-master at the ROW's studio; 404 otherwise), then the state check.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/invoices-queue/prepare', () => ({ recheckInvoiceRow: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { recheckInvoiceRow } = await import('@/lib/invoices-queue/prepare')
const { logError } = await import('@/lib/log')
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
  recheckInvoiceRow.mockResolvedValue({ reasons: [] })
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

  it('re-checks the saved row and answers its review reasons', async () => {
    getCurrentUser.mockResolvedValue(owner())
    recheckInvoiceRow.mockResolvedValue({ reasons: ['no_vat_rate'] })
    const res = await patch()
    expect(res.status).toBe(200)
    expect((await res.json()).data.review_reasons).toEqual(['no_vat_rate'])
    expect(recheckInvoiceRow).toHaveBeenCalledTimes(1)
    const [passedDb, fresh] = recheckInvoiceRow.mock.calls[0]
    expect(passedDb).toBe(db)
    expect(fresh).toMatchObject({ id: MINE, status: 'extracted', location_id: LOC_A })
    expect(fresh.extracted_fields.supplier_name).toBe('Acme Supplies')
  })

  it('a throwing re-check is logged; the save stands and the stored reasons are answered', async () => {
    getCurrentUser.mockResolvedValue(owner())
    db.tables.invoices_queue[0].review_reasons = ['missing_total']
    recheckInvoiceRow.mockRejectedValue(new Error('boom'))
    const res = await patch()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.review_reasons).toEqual(['missing_total'])
    expect(db.tables.invoices_queue[0].extracted_fields.supplier_name).toBe('Acme Supplies')
    expect(logError).toHaveBeenCalled()
  })

  it('a data_approved row with a Xero error is saved without a re-check', async () => {
    getCurrentUser.mockResolvedValue(owner())
    Object.assign(db.tables.invoices_queue[0], { status: 'data_approved', xero_error: 'no contact' })
    const res = await patch()
    expect(res.status).toBe(200)
    expect(db.tables.invoices_queue[0].extracted_fields.supplier_name).toBe('Acme Supplies')
    expect(recheckInvoiceRow).not.toHaveBeenCalled()
  })

  it('answers the fields as stored after the re-check', async () => {
    getCurrentUser.mockResolvedValue(owner())
    recheckInvoiceRow.mockResolvedValue({ reasons: [], fields: { ...FIELDS, tax_type: 'INPUT2', tax_type_source: 'derived' } })
    const body = await (await patch()).json()
    expect(body.data.extracted_fields).toMatchObject({ supplier_name: 'Acme Supplies', tax_type: 'INPUT2', tax_type_source: 'derived' })
  })

  it('a failed fresh read after the save answers the reasons the row was loaded with', async () => {
    getCurrentUser.mockResolvedValue(owner())
    db.tables.invoices_queue[0].review_reasons = ['no_account']
    // Fail only the third invoices_queue query: gate read, update, then the fresh read.
    const realFrom = db.from.bind(db)
    let n = 0
    db.from = (t) => {
      if (t === 'invoices_queue' && ++n === 3) {
        const b = realFrom(t)
        b.then = (res) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res)
        return b
      }
      return realFrom(t)
    }
    const res = await patch()
    expect(res.status).toBe(200)
    expect((await res.json()).data.review_reasons).toEqual(['no_account'])
    expect(recheckInvoiceRow).not.toHaveBeenCalled()
  })

  it('a row that moved on before the save answers 409, not 500', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const realFrom = db.from.bind(db)
    let n = 0
    db.from = (t) => {
      const b = realFrom(t)
      if (t === 'invoices_queue' && ++n === 1) {
        const orig = b.then.bind(b)
        b.then = (res, rej) => orig((r) => { db.tables.invoices_queue[0].status = 'data_approved'; return res(r) }, rej)
      }
      return b
    }
    const res = await patch()
    expect(res.status).toBe(409)
    expect(db.tables.invoices_queue[0].extracted_fields).toEqual({})
  })
})
