// BOOKKEEPER-APPROVALS.1 — invoices-queue provider coverage.
//
// We lock three things the registry-level isVisible+fetchPending
// pattern depends on:
//   1. isVisible() returns false for users without the bookkeeper
//      permission (registry uses this to drop the tab entirely).
//   2. fetchPending self-gates on the same predicate (defence in
//      depth — even if a future change calls fetchPending without
//      isVisible, non-bookkeepers still get an empty result).
//   3. fetchPending maps invoices_queue rows to the ApprovalItem
//      shape correctly — title from supplier_name, subtitle
//      including source label + invoice_number, reviewUrl pointing
//      at /invoices?focus=<id>.

import { describe, it, expect, vi } from 'vitest'
import { invoicesQueueProvider } from './invoices-queue'

function makeChain(terminal) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(terminal)),
  }
  return chain
}

describe('invoicesQueueProvider.isVisible', () => {
  it('returns true for master (default ON)', () => {
    expect(invoicesQueueProvider.isVisible({ role: 'master', activeLocation: { id: 'loc1' } })).toBe(true)
  })

  it('returns false for owner without an explicit permission', () => {
    expect(invoicesQueueProvider.isVisible({ role: 'owner', permissions: {} })).toBe(false)
  })

  it('returns true when permissions.bookkeeper is explicitly true', () => {
    expect(invoicesQueueProvider.isVisible({
      role: 'manager', permissions: { bookkeeper: true },
    })).toBe(true)
  })

  it('returns false when permissions.bookkeeper is explicitly false (master override)', () => {
    expect(invoicesQueueProvider.isVisible({
      role: 'master', permissions: { bookkeeper: false },
    })).toBe(false)
  })

  it('returns false for null user', () => {
    expect(invoicesQueueProvider.isVisible(null)).toBe(false)
  })
})

describe('invoicesQueueProvider.fetchPending', () => {
  it('returns empty for non-bookkeepers without hitting the DB', async () => {
    const db = { from: vi.fn() }
    const r = await invoicesQueueProvider.fetchPending(db, { role: 'staff' })
    expect(r).toEqual({ count: 0, items: [] })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns empty when no active location is set', async () => {
    const db = { from: vi.fn() }
    const r = await invoicesQueueProvider.fetchPending(db, {
      role: 'manager', permissions: { bookkeeper: true }, rolesByLocation: {},
    })
    expect(r).toEqual({ count: 0, items: [] })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('maps invoices_queue rows to the ApprovalItem shape', async () => {
    const chain = makeChain({
      data: [
        {
          id: 'q1', status: 'extracted', source_type: 'supplier_email',
          sender_email: 'ap@acme.com', subject: 'Invoice 001',
          received_at: '2026-05-19T10:00:00Z',
          extracted_at: '2026-05-19T10:05:00Z',
          data_reviewed_at: null,
          extracted_fields: {
            supplier_name: 'Acme', invoice_number: 'A001',
            total: 123.45, currency: 'EUR',
          },
          xero_error: null,
          location: { id: 'loc1', name: 'UN1T Dublin' },
        },
      ],
      error: null,
    })
    const db = { from: vi.fn(() => chain) }
    const r = await invoicesQueueProvider.fetchPending(db, { role: 'master', activeLocation: { id: 'loc1' } })
    expect(r.count).toBe(1)
    expect(r.items[0]).toMatchObject({
      id: 'q1',
      title: 'Acme',
      meta: 'UN1T Dublin',
      amount: 123.45,
      currency: 'EUR',
      reviewUrl: '/invoices?focus=q1',
    })
    expect(r.items[0].subtitle).toContain('Supplier')
    expect(r.items[0].subtitle).toContain('Acme')
    expect(r.items[0].subtitle).toContain('#A001')
    expect(r.items[0].submittedAt).toBe('2026-05-19T10:05:00Z')
  })

  it('marks data_approved + xero_error rows as "Retry"', async () => {
    const chain = makeChain({
      data: [
        {
          id: 'q2', status: 'data_approved', source_type: 'contractor_invoice',
          received_at: '2026-05-19T10:00:00Z',
          extracted_at: '2026-05-19T10:05:00Z',
          data_reviewed_at: '2026-05-19T10:10:00Z',
          extracted_fields: { supplier_name: 'Coach', invoice_number: 'C-1' },
          xero_error: 'Xero rejected: invalid AccountCode',
          location: { id: 'loc1', name: 'UN1T Dublin' },
        },
      ],
      error: null,
    })
    const db = { from: vi.fn(() => chain) }
    const r = await invoicesQueueProvider.fetchPending(db, { role: 'master', activeLocation: { id: 'loc1' } })
    expect(r.items[0].subtitle).toContain('Retry')
  })

  it('falls back to sender_email when supplier_name is missing', async () => {
    const chain = makeChain({
      data: [
        {
          id: 'q3', status: 'extracted', source_type: 'supplier_email',
          sender_email: 'unknown@vendor.com',
          received_at: '2026-05-19T10:00:00Z',
          extracted_at: null,
          extracted_fields: {},
          xero_error: null,
          location: null,
        },
      ],
      error: null,
    })
    const db = { from: vi.fn(() => chain) }
    const r = await invoicesQueueProvider.fetchPending(db, { role: 'master', activeLocation: { id: 'loc1' } })
    expect(r.items[0].subtitle).toContain('unknown@vendor.com')
  })

  it('scopes the query to user.activeLocation only', async () => {
    const chain = makeChain({ data: [], error: null })
    const db = { from: vi.fn(() => chain) }
    await invoicesQueueProvider.fetchPending(db, {
      role: 'owner', permissions: { bookkeeper: true },
      activeLocation: { id: 'loc-ACTIVE' },
      rolesByLocation: { 'loc-ACTIVE': 'owner', 'loc-OTHER': 'manager' },
    })
    // status filter is an .in() call with the pending statuses array.
    const inCalls = chain.in.mock.calls
    expect(inCalls.some((c) => c[0] === 'status')).toBe(true)
    // location filter is now .eq() on the single active location id —
    // not .in() against owner-locations.
    const eqCalls = chain.eq.mock.calls
    expect(eqCalls.some((c) => c[0] === 'location_id' && c[1] === 'loc-ACTIVE')).toBe(true)
    // And NOT scoping to loc-OTHER (the user's other location).
    expect(inCalls.some((c) =>
      c[0] === 'location_id' && Array.isArray(c[1]) && c[1].includes('loc-OTHER')
    )).toBe(false)
  })
})

describe('invoicesQueueProvider.countPending', () => {
  it('returns 0 for non-bookkeeper without DB hit', async () => {
    const db = { from: vi.fn() }
    const c = await invoicesQueueProvider.countPending(db, { role: 'staff' })
    expect(c).toBe(0)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('reads the count via head:true select scoped to active location', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn(() => Promise.resolve({ count: 7, error: null })),
    }
    const db = { from: vi.fn(() => chain) }
    const c = await invoicesQueueProvider.countPending(db, { role: 'master', activeLocation: { id: 'loc1' } })
    expect(c).toBe(7)
    expect(chain.eq).toHaveBeenCalledWith('location_id', 'loc1')
    // head:true means no rows fetched, only the count.
    const selectArg = chain.select.mock.calls[0][1]
    expect(selectArg.head).toBe(true)
    expect(selectArg.count).toBe('exact')
  })
})
