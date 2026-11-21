// POST /api/expenses/[id]/decline through the real withAuth wrapper, which only
// signs the caller in. The body, the claim (404 for one the caller cannot see,
// another studio's included), own claim (403), the approver (403) and the state
// (409) keep their order; the write and the push are unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/push-dedup', async (importOriginal) => ({ ...(await importOriginal()), notifyUsersOnce: vi.fn(async () => ({})) }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { POST } = await import('./route.js')

const CLAIM_A = 'e1000000-0000-4000-8000-00000000000a'
const CLAIM_B = 'e1000000-0000-4000-8000-00000000000b'
const CLAIMANT = 'c1a10000-0000-4000-8000-000000000001'
const APPROVER_A = person({ [LOC_A]: { role: 'manager', permissions: { approvals_fte_expenses: true } } }, LOC_A)
const COACH_A = person({ [LOC_A]: { role: 'staff', permissions: { approvals_fte_expenses: false } } }, LOC_A)
const decline = (id, body = { reason: 'Missing receipt' }) => POST(new Request(`http://localhost/api/expenses/${id}/decline`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    profiles: [{ id: CLAIMANT, full_name: 'Claimant', email: 'claimant@example.com' }],
    fte_expense_claims: [
      { id: CLAIM_A, profile_id: CLAIMANT, location_id: LOC_A, status: 'submitted', period_start: '2026-10-01', total_amount: 42 },
      { id: CLAIM_B, profile_id: CLAIMANT, location_id: LOC_B, status: 'submitted', period_start: '2026-10-01', total_amount: 42 },
    ],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/expenses/[id]/decline', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await decline(CLAIM_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.fte_expense_claims[0].status).toBe('submitted')
  })

  it('404 for another studio’s claim, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(APPROVER_A)
    expect((await decline(CLAIM_B)).status).toBe(404)
    expect(db.tables.fte_expense_claims[1].status).toBe('submitted')
  })

  it('404 for a coach without the approval permission (cannot see the claim)', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    expect((await decline(CLAIM_A)).status).toBe(404)
  })

  it('403 on the caller’s own claim', async () => {
    getCurrentUser.mockResolvedValue({ ...APPROVER_A, id: CLAIMANT })
    expect((await decline(CLAIM_A)).status).toBe(403)
    expect(db.tables.fte_expense_claims[0].status).toBe('submitted')
  })

  it('an approver at the studio declines it and the claimant is told', async () => {
    getCurrentUser.mockResolvedValue(APPROVER_A)
    const res = await decline(CLAIM_A)
    expect(res.status).toBe(200)
    expect(db.tables.fte_expense_claims[0]).toMatchObject({ status: 'declined', decline_reason: 'Missing receipt', reviewed_by: APPROVER_A.id })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
  })

  it('a failed push is a fixed warning, never the provider text', async () => {
    getCurrentUser.mockResolvedValue(APPROVER_A)
    notifyUsersOnce.mockRejectedValueOnce(new Error('Expo push 500: token DeviceNotRegistered ExponentPushToken[abc]'))
    const body = await (await decline(CLAIM_A)).json()
    expect(body.success).toBe(true)
    expect(body.warning).toBe('The claimant could not be notified.')
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(APPROVER_A)
    db.errors.fte_expense_claims = { update: { message: 'new row for relation "fte_expense_claims" violates check constraint' } }
    const res = await decline(CLAIM_A)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not decline the claim. Refresh and try again.' })
  })
})
