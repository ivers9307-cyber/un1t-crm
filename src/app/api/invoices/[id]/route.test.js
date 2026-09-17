import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contractor-invoices', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    computeScheduledForPeriod: vi.fn(async () => ({ scheduled_hours: 0, estimated_cost: 0, hourly_rate: 0 })),
  }
})

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { computeScheduledForPeriod } from '@/lib/contractor-invoices'
import { GET } from './route.js'

// db.from(t).select(c).eq(col,val).single() -> { data, error }
// invoices_queue: db.from(t).select(c).in(..).in(..) -> { data: queueRows }
function mockDb(result, queueRows = []) {
  let table = null
  const b = {
    from: (t) => { table = t; return b },
    select: () => b,
    eq: () => b,
    in: () => b,
    single: () => Promise.resolve(result),
    then: (res, rej) => Promise.resolve(
      table === 'invoices_queue' ? { data: queueRows, error: null } : { data: null, error: null },
    ).then(res, rej),
  }
  return b
}

const INV = { id: 'inv1', contractor_id: 'c1', location_id: 'locA' }
const props = { params: Promise.resolve({ id: 'inv1' }) }

describe('GET /api/invoices/[id] — existence-leak guard + tiers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createServerClient.mockReturnValue(mockDb({ data: INV, error: null }))
  })

  // The fix: a non-self, non-owner-here, non-master caller gets 404 (was 403).
  it('404 (NOT 403) for a cross-org owner who is neither self nor owner-here', async () => {
    getCurrentUser.mockResolvedValue({ id: 'other', role: 'owner', rolesByLocation: { locB: 'owner' } })
    const res = await GET({}, props)
    expect(res.status).toBe(404)
  })

  // The self-contractor tier must be PRESERVED by the fix.
  it('self contractor still gets their own invoice (200, viewer_role=self)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c1', role: 'staff', rolesByLocation: {} })
    const res = await GET({}, props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.viewer_role).toBe('self')
  })

  it('owner at the invoice location gets it (200, viewer_role=owner)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
    const res = await GET({}, props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.viewer_role).toBe('owner')
  })
})

// INVOICEREVIEW.2 — snapshot-after-approval + honest lifecycle label.
describe('GET /api/invoices/[id] — review snapshot + lifecycle', () => {
  const APPROVED = {
    id: 'inv1', contractor_id: 'c1', location_id: 'locA',
    status: 'awaiting_accountant_review', invoice_amount: '800.00',
    approved_at: '2026-09-02T10:00:00Z', reviewed_at: '2026-09-02T10:00:00Z',
    scheduled_hours_at_review: '40.00', estimated_cost_at_review: '800.00', hourly_rate_at_review: '20.00',
  }
  const QUEUE = [{ id: 'q1', source_contractor_invoice_id: 'inv1', status: 'forwarded', xero_bill_id: 'b1', created_at: '2026-09-03T00:00:00Z' }]

  beforeEach(() => {
    vi.clearAllMocks()
    createServerClient.mockReturnValue(mockDb({ data: APPROVED, error: null }, QUEUE))
  })

  it('owner sees the SAVED snapshot as primary and the drifted live roster as current', async () => {
    computeScheduledForPeriod.mockResolvedValueOnce({ scheduled_hours: 36, shift_count: 9, hourly_rate: 20, estimated_cost: 720 })
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
    const body = await (await GET({}, props)).json()
    expect(body.data.review_comparison.primary).toMatchObject({ source: 'snapshot', as_of: '2026-09-02T10:00:00Z', scheduled_hours: 40, estimated_cost: 800 })
    expect(body.data.review_comparison.primary.comparison.verdict).toBe('matches')
    expect(body.data.review_comparison.current).toMatchObject({ source: 'live', scheduled_hours: 36 })
    expect(body.data.lifecycle).toMatchObject({ key: 'sent_to_xero', label: 'Sent to Xero' })
  })

  it('a live recompute failure still returns the snapshot (no 500)', async () => {
    computeScheduledForPeriod.mockRejectedValueOnce(new Error('boom'))
    getCurrentUser.mockResolvedValue({ id: 'm1', role: 'master', rolesByLocation: {} })
    const res = await GET({}, props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.review_comparison.primary.source).toBe('snapshot')
    expect(body.data.review_comparison.current).toBeNull()
  })

  it('reads "Approved, not yet queued" when no queue row exists', async () => {
    createServerClient.mockReturnValue(mockDb({ data: APPROVED, error: null }, []))
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
    const body = await (await GET({}, props)).json()
    expect(body.data.lifecycle.key).toBe('approved_not_queued')
  })

  it('self contractor gets the lifecycle but never the rate × hours snapshot', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c1', role: 'staff', rolesByLocation: {} })
    const body = await (await GET({}, props)).json()
    expect(body.data.lifecycle.label).toBe('Sent to Xero')
    expect(body.data.review_comparison).toBeNull()
    expect(body.data.computed_scheduled).toBeNull()
    expect(body.data).not.toHaveProperty('estimated_cost_at_review')
    expect(body.data).not.toHaveProperty('hourly_rate_at_review')
    expect(body.data).not.toHaveProperty('scheduled_hours_at_review')
    expect(computeScheduledForPeriod).not.toHaveBeenCalled()
  })
})
