import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { GET } from './route.js'
import { GET as GET_ONE } from './[id]/route.js'

// Every chain resolves by table; the claim detail resolves via maybeSingle.
function mockDb(tables) {
  return {
    from(table) {
      const b = {}
      for (const m of ['select', 'order', 'limit', 'eq', 'or', 'in', 'range', 'not']) b[m] = () => b
      b.maybeSingle = () => Promise.resolve(tables[`${table}:single`] || { data: null, error: null })
      b.then = (res, rej) => Promise.resolve(tables[table] || { data: [], error: null }).then(res, rej)
      return b
    },
  }
}

const CLAIMS = [
  { id: 'c1', profile_id: 'u1', location_id: 'L1', status: 'awaiting_accountant_review' },
  { id: 'c2', profile_id: 'u1', location_id: 'L1', status: 'awaiting_accountant_review' },
  { id: 'c3', profile_id: 'u1', location_id: 'L1', status: 'draft' },
]

describe('GET /api/expenses — lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', rolesByLocation: {} })
  })

  it('labels each claim from its items\' queue rows', async () => {
    createServerClient.mockReturnValue(mockDb({
      fte_expense_claims: { data: CLAIMS, error: null },
      fte_expense_items: { data: [{ id: 'i1', claim_id: 'c1' }, { id: 'i2', claim_id: 'c2' }], error: null },
      invoices_queue: { data: [
        { source_fte_expense_item_id: 'i1', status: 'forwarded', xero_bill_id: 'b', xero_bill_status: 'DRAFT' },
        { source_fte_expense_item_id: 'i2', status: 'quality_approved' },
      ], error: null },
    }))
    const res = await GET(new Request('http://x/api/expenses'))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((c) => c.lifecycle.label)).toEqual([
      'Sent to Xero', 'Approved, queued for accountant', 'Draft',
    ])
  })

  it('a failed queue read gives plain Approved, not a guess', async () => {
    createServerClient.mockReturnValue(mockDb({
      fte_expense_claims: { data: CLAIMS.slice(0, 1), error: null },
      fte_expense_items: { data: [{ id: 'i1', claim_id: 'c1' }], error: null },
      invoices_queue: { data: null, error: { message: 'timeout' } },
    }))
    const body = await (await GET(new Request('http://x/api/expenses'))).json()
    expect(body.data[0].lifecycle.label).toBe('Approved')
  })
})

describe('GET /api/expenses/[id] — lifecycle', () => {
  it('returns the lifecycle alongside the claim', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', rolesByLocation: {} })
    createServerClient.mockReturnValue(mockDb({
      'fte_expense_claims:single': { data: { ...CLAIMS[0], items: [] }, error: null },
      fte_expense_items: { data: [{ id: 'i1', claim_id: 'c1' }], error: null },
      invoices_queue: { data: [{ source_fte_expense_item_id: 'i1', status: 'rejected' }], error: null },
    }))
    const res = await GET_ONE({}, { params: Promise.resolve({ id: 'c1' }) })
    const body = await res.json()
    expect(body.data.viewer_role).toBe('self')
    expect(body.data.lifecycle.label).toBe('Approved, rejected by accountant')
  })
})
