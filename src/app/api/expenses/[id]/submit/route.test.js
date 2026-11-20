// FTE-EXPENSES.1 — POST /api/expenses/[id]/submit through the real withAuth
// wrapper. The hand-written checks keep their order: a claim the caller cannot
// see 404, not the submitter 403, wrong state 409, no items 400.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/push-dedup', () => ({ sendPushToRolesAtLocationOnce: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { sendPushToRolesAtLocationOnce } = await import('@/lib/push-dedup')
const { POST } = await import('./route.js')

const MINE = 'e5000000-0000-4000-8000-000000000001'
const THEIRS = 'e5000000-0000-4000-8000-000000000002'
const claim = (id, profileId, loc, extra = {}) => ({
  id, profile_id: profileId, location_id: loc, status: 'draft', period_start: '2026-11-01', item_count: 2, total_amount: 42.5, ...extra,
})
const post = (id) => POST(new Request(`http://localhost/api/expenses/${id}/submit`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const staffAtA = () => person({ [LOC_A]: { role: 'staff' } }, LOC_A)
let db
const seed = (claims) => {
  db = createFakeDb({ tables: { locations: [{ id: LOC_A, name: 'Studio A' }, { id: LOC_B, name: 'Studio B' }], fte_expense_claims: claims } })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => {
  vi.clearAllMocks()
  seed([claim(MINE, 'user-1', LOC_A), claim(THEIRS, 'user-2', LOC_B)])
})

describe('POST /api/expenses/[id]/submit', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(MINE)).status).toBe(401)
    expect(db.tables.fte_expense_claims[0].status).toBe('draft')
  })

  it('404 for another person\'s claim at a studio the caller has no say in', async () => {
    getCurrentUser.mockResolvedValue(staffAtA())
    const res = await post(THEIRS)
    expect(res.status).toBe(404)
    expect(db.tables.fte_expense_claims[1].status).toBe('draft')
  })

  it('403 for an owner who can see the claim but did not submit it', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner' } }, LOC_B))
    const res = await post(THEIRS)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Only the submitter can submit this claim.' })
  })

  it('409 for a claim already submitted; 400 for an empty one', async () => {
    getCurrentUser.mockResolvedValue(staffAtA())
    seed([claim(MINE, 'user-1', LOC_A, { status: 'submitted' })])
    expect((await post(MINE)).status).toBe(409)
    seed([claim(MINE, 'user-1', LOC_A, { item_count: 0 })])
    expect((await post(MINE)).status).toBe(400)
  })

  it('the submitter submits their draft and the approvers are told', async () => {
    getCurrentUser.mockResolvedValue(staffAtA())
    const res = await post(MINE)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ id: MINE, status: 'submitted' })
    expect(db.tables.fte_expense_claims[0].status).toBe('submitted')
    expect(sendPushToRolesAtLocationOnce).toHaveBeenCalledTimes(1)
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(staffAtA())
    db = createFakeDb({ tables: { locations: [{ id: LOC_A, name: 'Studio A' }], fte_expense_claims: [claim(MINE, 'user-1', LOC_A)] }, errors: { fte_expense_claims: { update: { message: 'secret detail' } } } })
    createServerClient.mockReturnValue(db)
    const res = await post(MINE)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
