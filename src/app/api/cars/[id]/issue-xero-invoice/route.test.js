// POST /api/cars/[id]/issue-xero-invoice through the real withAuth wrapper,
// which only signs the caller in (401 'Unauthorized'; was 'Unauthorised').
// car_processing somewhere (403), the car (404), its studio (404, never 403),
// car_processing there (403), already issued (409) and the fields (400) keep
// their order before the one Xero call.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/xero/invoices', async (importOriginal) => ({
  ...(await importOriginal()),
  issueCarInvoice: vi.fn(),
  validateInvoiceFields: vi.fn(() => []),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { issueCarInvoice } = await import('@/lib/xero/invoices')
const { XeroError } = await import('@/lib/xero/client')
const { POST } = await import('./route.js')

const CAR_A = 'ca000000-0000-4000-8000-00000000001a'
const CAR_B = 'ca000000-0000-4000-8000-00000000001b'
const CARS_A = person({ [LOC_A]: { role: 'manager', permissions: { car_processing: true } } }, LOC_A)
const NO_CARS = person({ [LOC_A]: { role: 'manager', permissions: { car_processing: false } } }, LOC_A)
const RESULT = { invoiceId: 'inv-1', invoiceNumber: 'INV-0001', invoiceUrl: 'u', onlineInvoiceUrl: 'o', pdfPath: 'p', amount: 100, brandingThemeId: 'b', emailedAt: null, issuedAt: '2026-11-21T00:00:00Z' }
const issue = (id) => POST(new Request(`http://localhost/api/cars/${id}/issue-xero-invoice`, { method: 'POST' }), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({
    tables: { cars: [{ id: CAR_A, location_id: LOC_A, xero_invoice_id: null }, { id: CAR_B, location_id: LOC_B, xero_invoice_id: null }] },
    rpc: { increment_car_xero_issue_count: () => null },
  })
  createServerClient.mockReturnValue(db)
  issueCarInvoice.mockResolvedValue(RESULT)
})

describe('POST /api/cars/[id]/issue-xero-invoice', () => {
  it('401 signed out, Xero never called', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await issue(CAR_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(issueCarInvoice).not.toHaveBeenCalled()
  })

  it('403 without car_processing anywhere', async () => {
    getCurrentUser.mockResolvedValue(NO_CARS)
    const res = await issue(CAR_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not permitted' })
    expect(issueCarInvoice).not.toHaveBeenCalled()
  })

  it('404 for another studio’s car, Xero never called', async () => {
    getCurrentUser.mockResolvedValue(CARS_A)
    expect((await issue(CAR_B)).status).toBe(404)
    expect(issueCarInvoice).not.toHaveBeenCalled()
  })

  it('issues once and stores the invoice on the car', async () => {
    getCurrentUser.mockResolvedValue(CARS_A)
    const res = await issue(CAR_A)
    expect(res.status).toBe(200)
    expect(issueCarInvoice).toHaveBeenCalledTimes(1)
    expect(db.tables.cars[0]).toMatchObject({ xero_invoice_id: 'inv-1', xero_invoice_number: 'INV-0001' })
  })

  it('Xero’s field messages still reach the operator; its top-level text does not', async () => {
    getCurrentUser.mockResolvedValue(CARS_A)
    issueCarInvoice.mockRejectedValueOnce(new XeroError('A validation exception occurred', {
      status: 400, body: { Elements: [{ ValidationErrors: [{ Message: 'Account code 200 is not a valid code' }] }] },
    }))
    let res = await issue(CAR_A)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      success: false,
      error: 'Xero refused the invoice — Account code 200 is not a valid code',
      validationDetails: ['Account code 200 is not a valid code'],
    })
    issueCarInvoice.mockRejectedValueOnce(new XeroError('Failed to load Xero connection: permission denied for table xero_connections'))
    res = await issue(CAR_A)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Xero could not issue the invoice. Try again.' })
  })

  it('a failed save after issuing names the invoice, never the database text', async () => {
    getCurrentUser.mockResolvedValue(CARS_A)
    db.errors.cars = { update: { message: 'column "xero_invoice_pdf_path" is of type text' } }
    const res = await issue(CAR_A)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Invoice created in Xero (INV-0001) but saving it on the car failed.')
    expect(JSON.stringify(body)).not.toContain('column')
  })
})
