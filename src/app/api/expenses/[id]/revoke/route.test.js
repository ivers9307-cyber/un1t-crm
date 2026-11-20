// FTE-EXPENSES.1 — POST /api/expenses/[id]/revoke through the real withAuth
// wrapper (ROUTEWRAP.R6): a claim the caller cannot see is a 404, one they
// can see but did not submit a 403, and only a submitted claim revokes.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => {}) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const CLAIM = 'c5000000-0000-4000-8000-000000000001'
const SUBMITTER = 'c6000000-0000-4000-8000-000000000001'
let db
const revoke = () => POST(new Request(`http://localhost/api/expenses/${CLAIM}/revoke`, { method: 'POST' }), { params: Promise.resolve({ id: CLAIM }) })
const claim = () => db.tables.fte_expense_claims[0]
const submitter = () => ({ ...person({ [LOC_A]: { role: 'staff' } }, LOC_A), id: SUBMITTER })

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { fte_expense_claims: [{ id: CLAIM, profile_id: SUBMITTER, location_id: LOC_A, status: 'submitted', period_start: '2026-11-01', total_amount: 12.5 }] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/expenses/[id]/revoke', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await revoke()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(claim().status).toBe('submitted')
  })

  it('404 for someone at another studio who cannot see the claim', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner' } }, LOC_B))
    expect((await revoke()).status).toBe(404)
    expect(claim().status).toBe('submitted')
  })

  it("403 for the studio's owner, who can see it but did not submit it", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await revoke()
    expect(res.status).toBe(403)
    expect(claim().status).toBe('submitted')
  })

  it('the submitter revokes a submitted claim; a second revoke is a 409', async () => {
    getCurrentUser.mockResolvedValue(submitter())
    const res = await revoke()
    expect(res.status).toBe(200)
    expect(claim().status).toBe('revoked')
    expect((await revoke()).status).toBe(409)
  })

  it('a failed write is a 500 with a fixed message', async () => {
    getCurrentUser.mockResolvedValue(submitter())
    db.errors.fte_expense_claims = { update: { code: '57014', message: 'statement timeout on fte_expense_claims' } }
    const res = await revoke()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/fte_expense_claims/)
  })
})
