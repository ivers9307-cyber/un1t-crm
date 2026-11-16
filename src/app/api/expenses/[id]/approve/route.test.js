// APPROVEQUEUE.1 — an expense approval that cannot reach the bookkeeper is put
// back (the claim stays in the approvals list to retry), and losing a race to
// another approver is a 409, not raw database text.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'mgr', full_name: 'M', email: 'm@example.test' })) }))
vi.mock('@/lib/fte-expense-access', () => ({ canApproveExpenseClaim: () => true, canSeeExpenseClaim: () => true }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/invoices-queue/enqueue', () => ({ enqueueFromFteExpenseClaim: vi.fn(async () => ({ ok: true, queueIds: ['q1'] })) }))

const CLAIM = { id: 'cl1', profile_id: 'staff1', location_id: 'loc1', status: 'submitted', period_start: '2026-10-01', total_amount: 42, item_count: 2 }
let updates, approveAnswer, revertRows
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => {
    const b = {
      from: () => b, select: () => b, eq: () => b,
      update: (u) => { updates.push(u); return b },
      maybeSingle: () => Promise.resolve(updates.length === 0 ? { data: CLAIM, error: null } : approveAnswer),
      then: (res) => Promise.resolve({ data: revertRows, error: null }).then(res),
    }
    return b
  },
}))

const { POST } = await import('./route.js')
const { enqueueFromFteExpenseClaim } = await import('@/lib/invoices-queue/enqueue')
const { logError } = await import('@/lib/log')
const call = () => POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'cl1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  approveAnswer = { data: { ...CLAIM, status: 'awaiting_accountant_review' }, error: null }
  revertRows = [{ id: 'cl1' }]
})

describe('POST /api/expenses/[id]/approve', () => {
  it('approves and queues', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(updates[0]).toMatchObject({ status: 'awaiting_accountant_review', reviewed_by: 'mgr' })
    expect(updates).toHaveLength(1)
  })

  it('a failed hand-off puts the approval back and says it was not approved', async () => {
    enqueueFromFteExpenseClaim.mockResolvedValueOnce({ ok: false, error: 'Queue insert failed: down' })
    const res = await call()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/still waiting for approval/)
    expect(updates[1]).toEqual({ status: 'submitted', reviewed_at: null, reviewed_by: null, approved_at: null })
  })

  it('when the approval cannot be put back either, it reports and logs', async () => {
    enqueueFromFteExpenseClaim.mockResolvedValueOnce({ ok: false, error: 'Queue insert failed: down' })
    revertRows = []
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).warning).toMatch(/did not reach the bookkeeper/)
    expect(logError).toHaveBeenCalled()
  })

  it('another approver got there first: a 409, not database text', async () => {
    approveAnswer = { data: null, error: null }
    const res = await call()
    expect(res.status).toBe(409)
    expect(enqueueFromFteExpenseClaim).not.toHaveBeenCalled()
  })
})
