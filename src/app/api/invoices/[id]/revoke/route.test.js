// POST /api/invoices/[id]/revoke through the real withAuth wrapper: a
// contractor's self-revoke. Signed in, then the row (404), the owner check
// (404, never 403), the status (409) and the guarded write, in that order.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const MINE = 'c1000000-0000-4000-8000-000000000001'
const THEIRS = 'c1000000-0000-4000-8000-000000000002'
const ME = person({ [LOC_A]: { role: 'staff' } }, LOC_A)
const revoke = (id = MINE) => POST(new Request(`http://localhost/api/invoices/${id}/revoke`, { method: 'POST' }), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { contractor_invoices: [
    { id: MINE, contractor_id: 'user-1', status: 'submitted', location_id: LOC_A },
    { id: THEIRS, contractor_id: 'user-2', status: 'submitted', location_id: LOC_A },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/invoices/[id]/revoke', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await revoke()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.contractor_invoices[0].status).toBe('submitted')
  })

  it('404 for someone else’s invoice, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(ME)
    const res = await revoke(THEIRS)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Invoice not found' })
    expect(db.tables.contractor_invoices[1].status).toBe('submitted')
  })

  it('revokes the caller’s own submitted invoice', async () => {
    getCurrentUser.mockResolvedValue(ME)
    const res = await revoke()
    expect(res.status).toBe(200)
    expect(db.tables.contractor_invoices[0].status).toBe('revoked')
  })

  it('409 once approved', async () => {
    db.tables.contractor_invoices[0].status = 'approved'
    getCurrentUser.mockResolvedValue(ME)
    expect((await revoke()).status).toBe(409)
  })

  it('a failed write answers a fixed 400, never the database text', async () => {
    getCurrentUser.mockResolvedValue(ME)
    db.errors.contractor_invoices = { update: { message: 'new row violates check constraint "contractor_invoices_status_check"' } }
    const res = await revoke()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not revoke the invoice. Refresh and try again.' })
  })
})
