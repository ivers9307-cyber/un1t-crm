// INVOICEHOURS.1 D9 — approval snapshots the roster figures; a failed roster
// read must refuse the approval cleanly (503, nothing written), not throw a
// bare 500 and not save a null snapshot that later reads "approved before
// snapshots were saved".

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/contractor-invoices', async (importOriginal) => ({
  ...(await importOriginal()),
  computeScheduledForPeriod: vi.fn(),
}))
vi.mock('@/lib/contractor-invoice-email', () => ({ sendInvoiceApprovedEmail: vi.fn(async () => {}) }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(async () => {}) }))
vi.mock('@/lib/invoices-queue/enqueue', () => ({ enqueueFromContractorInvoice: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { computeScheduledForPeriod } from '@/lib/contractor-invoices'
import { logError } from '@/lib/log'
import { POST } from './route.js'

const INV = {
  id: 'inv1', contractor_id: 'c1', location_id: 'locA',
  period_start: '2026-09-01', period_end: '2026-09-30', status: 'submitted',
}
const props = { params: Promise.resolve({ id: 'inv1' }) }

// select().eq().single() → the invoice; update().eq().eq().select().single()
// → the updated row. Records every update payload.
function mockDb() {
  const updates = []
  const b = {
    from: () => b,
    select: () => b,
    eq: () => b,
    update: (u) => { updates.push(u); return b },
    single: () => Promise.resolve(updates.length
      ? { data: { ...INV, ...updates[0], invoice_amount: '160.00' }, error: null }
      : { data: INV, error: null }),
  }
  return { db: b, updates }
}

describe('POST /api/invoices/[id]/approve — INVOICEHOURS.1', () => {
  let m
  beforeEach(() => {
    vi.clearAllMocks()
    m = mockDb()
    createServerClient.mockReturnValue(m.db)
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
  })

  it('a failed roster read answers 503, writes nothing, and logs', async () => {
    computeScheduledForPeriod.mockRejectedValueOnce(new Error('Assignment lookup failed: boom'))
    const res = await POST({}, props)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/Could not read the roster/)
    expect(m.updates).toHaveLength(0)
    expect(logError).toHaveBeenCalledWith('invoice-approve', expect.any(String), expect.objectContaining({ invoiceId: 'inv1' }))
  })

  it('a good read snapshots the published-only figures', async () => {
    computeScheduledForPeriod.mockResolvedValueOnce({
      scheduled_hours: 8, shift_count: 1, hourly_rate: 20, estimated_cost: 160,
      unpublished_hours: 2, unpublished_shift_count: 1,
    })
    const res = await POST({}, props)
    expect(res.status).toBe(200)
    expect(m.updates).toHaveLength(1)
    expect(m.updates[0]).toMatchObject({
      status: 'awaiting_accountant_review',
      scheduled_hours_at_review: 8,
      estimated_cost_at_review: 160,
      hourly_rate_at_review: 20,
    })
  })
})
