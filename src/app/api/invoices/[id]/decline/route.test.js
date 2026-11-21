// POST /api/invoices/[id]/decline through the real withAuth wrapper: signed in
// (the same 401), the body, the invoice, the contractor-invoice approval
// permission AT the invoice's studio (404 otherwise, never 403), submitted only
// (409); then the decline write, the email and the push.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/contractor-invoice-email', async (importOriginal) => ({ ...(await importOriginal()), sendInvoiceDeclinedEmail: vi.fn(async () => ({})) }))
vi.mock('@/lib/push-dedup', async (importOriginal) => ({ ...(await importOriginal()), notifyUsersOnce: vi.fn(async () => ({})) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { sendInvoiceDeclinedEmail } = await import('@/lib/contractor-invoice-email')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { POST } = await import('./route.js')

const KEY = 'approvals_contractor_invoices'
const INV_B = 'b1000000-0000-4000-8000-0000000000b4'
const INV_FAR = 'b1000000-0000-4000-8000-0000000000f4'
const decline = (id, body = { reason: 'Hours do not match the roster' }) => POST(new Request(`http://localhost/api/invoices/${id}/decline`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
const approverAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { [KEY]: a } }, [LOC_B]: { role: 'owner', permissions: { [KEY]: b } } }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    contractor_invoices: [
      { id: INV_B, contractor_id: 'c0000000-0000-4000-8000-0000000000c1', location_id: LOC_B, status: 'submitted', period_start: '2026-10-01' },
      { id: INV_FAR, contractor_id: 'c0000000-0000-4000-8000-0000000000c1', location_id: LOC_OTHER, status: 'submitted', period_start: '2026-10-01' },
    ],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/invoices/[id]/decline', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await decline(INV_B)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.contractor_invoices[0].status).toBe('submitted')
  })

  it('404 (not 403) without the approval permission at the invoice studio', async () => {
    getCurrentUser.mockResolvedValue(approverAt(true, false))
    expect((await decline(INV_B)).status).toBe(404)
    expect(db.tables.contractor_invoices[0].status).toBe('submitted')
  })

  it("404 for another studio's invoice", async () => {
    getCurrentUser.mockResolvedValue(approverAt(true, true))
    expect((await decline(INV_FAR)).status).toBe(404)
    expect(db.tables.contractor_invoices[1].status).toBe('submitted')
  })

  it('409 once the invoice is no longer submitted', async () => {
    getCurrentUser.mockResolvedValue(approverAt(false, true))
    db.tables.contractor_invoices[0].status = 'approved'
    expect((await decline(INV_B)).status).toBe(409)
  })

  it('declines, emails and pushes', async () => {
    getCurrentUser.mockResolvedValue(approverAt(false, true))
    const res = await decline(INV_B)
    expect(res.status).toBe(200)
    expect(db.tables.contractor_invoices[0]).toMatchObject({ status: 'declined', decline_reason: 'Hours do not match the roster', reviewed_by: 'user-1' })
    expect(sendInvoiceDeclinedEmail).toHaveBeenCalledWith(INV_B)
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
  })

  it('a failed email is a fixed warning, without the provider text', async () => {
    getCurrentUser.mockResolvedValue(approverAt(false, true))
    sendInvoiceDeclinedEmail.mockRejectedValueOnce(new Error('postmark said no to someone@example.com'))
    const body = await (await decline(INV_B)).json()
    expect(body.success).toBe(true)
    expect(body.warnings).toEqual(['Decline email failed. Contractor will see the status next time they open Invoices.'])
  })

  it('a failed write is a 400 without the database text', async () => {
    getCurrentUser.mockResolvedValue(approverAt(false, true))
    db.errors.contractor_invoices = { update: { message: 'secret db text' } }
    const res = await decline(INV_B)
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('secret db text')
  })
})
