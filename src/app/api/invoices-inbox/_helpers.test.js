import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { loadInvoiceForUser } from './_helpers.js'

// db.from(t).select(c).eq(col,val).maybeSingle() -> { data, error }
function mockDb(result) {
  const b = { from: () => b, select: () => b, eq: () => b, maybeSingle: () => Promise.resolve(result) }
  return b
}

const ROW = { id: 'inv1', location_id: 'locA' }

describe('loadInvoiceForUser — existence-leak guard (covers all invoices-inbox/[id]/* routes)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createServerClient.mockReturnValue(mockDb({ data: ROW, error: null }))
  })

  it('401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const r = await loadInvoiceForUser('inv1')
    expect(r.response.status).toBe(401)
  })

  it('404 when the row is absent', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', rolesByLocation: { locA: 'owner' } })
    createServerClient.mockReturnValue(mockDb({ data: null, error: null }))
    const r = await loadInvoiceForUser('inv1')
    expect(r.response.status).toBe(404)
  })

  it('returns the row for an owner at the invoice location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', rolesByLocation: { locA: 'owner' } })
    const r = await loadInvoiceForUser('inv1')
    expect(r.row?.id).toBe('inv1')
    expect(r.response).toBeUndefined()
  })

  it('returns the row for a master', async () => {
    getCurrentUser.mockResolvedValue({ role: 'master', rolesByLocation: {} })
    const r = await loadInvoiceForUser('inv1')
    expect(r.row?.id).toBe('inv1')
  })

  // The fix: a caller who owns a DIFFERENT location must get 404, not 403 —
  // otherwise the status code leaks that this invoice exists at another org.
  it('404 (NOT 403) for a cross-org owner — no existence leak', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', rolesByLocation: { locB: 'owner' } })
    const r = await loadInvoiceForUser('inv1')
    expect(r.response.status).toBe(404)
    expect(r.row).toBeUndefined()
  })
})
