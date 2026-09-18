import { describe, it, expect, vi } from 'vitest'

vi.mock('./log.js', () => ({ logWarn: vi.fn() }))

import { loadQueueRowsForExpenseClaims, withExpenseLifecycle } from './fte-expense-lifecycle.js'

// Chainable supabase stub: each table resolves to results[table]
// (an object, or a function of the recorded filters).
function mockDb(results, calls = []) {
  return {
    from(table) {
      const filters = []
      const b = {
        select: () => b,
        order: () => b,
        range: (a, z) => { filters.push(['range', a, z]); return b },
        in: (col, vals) => { filters.push(['in', col, vals]); return b },
        then: (res, rej) => {
          calls.push([table, filters])
          const r = results[table]
          return Promise.resolve(typeof r === 'function' ? r(filters) : (r || { data: [], error: null })).then(res, rej)
        },
      }
      return b
    },
  }
}

const AW = (id, loc = 'L1') => ({ id, status: 'awaiting_accountant_review', location_id: loc })

describe('loadQueueRowsForExpenseClaims', () => {
  it('does not query for claims that are not awaiting the accountant', async () => {
    const calls = []
    const lookup = await loadQueueRowsForExpenseClaims(mockDb({}, calls), [{ id: 'd', status: 'draft' }])
    expect(calls).toEqual([])
    expect(lookup('d')).toBeUndefined()
  })

  it('groups items and queue rows per claim, scoped by location', async () => {
    const calls = []
    const db = mockDb({
      fte_expense_items: { data: [{ id: 'i1', claim_id: 'c1' }, { id: 'i2', claim_id: 'c1' }, { id: 'i3', claim_id: 'c2' }], error: null },
      invoices_queue: { data: [
        { id: 'q1', source_fte_expense_item_id: 'i1', status: 'forwarded' },
        { id: 'q3', source_fte_expense_item_id: 'i3', status: 'rejected' },
      ], error: null },
    }, calls)
    const lookup = await loadQueueRowsForExpenseClaims(db, [AW('c1'), AW('c2', 'L2')])
    expect(lookup('c1').itemIds).toEqual(['i1', 'i2'])
    expect(lookup('c1').rows.map((r) => r.id)).toEqual(['q1'])
    expect(lookup('c2').rows.map((r) => r.id)).toEqual(['q3'])
    const queueCall = calls.find(([t]) => t === 'invoices_queue')
    expect(queueCall[1]).toContainEqual(['in', 'location_id', ['L1', 'L2']])
  })

  it('a failed queue read leaves the claim undefined (never "not queued")', async () => {
    const db = mockDb({
      fte_expense_items: { data: [{ id: 'i1', claim_id: 'c1' }], error: null },
      invoices_queue: { data: null, error: { message: 'down' } },
    })
    const lookup = await loadQueueRowsForExpenseClaims(db, [AW('c1')])
    expect(lookup('c1')).toBeUndefined()
  })

  it('a failed item read leaves the claim undefined', async () => {
    const db = mockDb({ fte_expense_items: { data: null, error: { message: 'down' } } })
    const lookup = await loadQueueRowsForExpenseClaims(db, [AW('c1')])
    expect(lookup('c1')).toBeUndefined()
  })

  it('pages items past the 1000-row cap', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, claim_id: 'c1' }))
    const db = mockDb({
      fte_expense_items: (filters) => {
        const [, from] = filters.find((f) => f[0] === 'range')
        return { data: from === 0 ? page1 : [{ id: 'last', claim_id: 'c1' }], error: null }
      },
      invoices_queue: { data: [], error: null },
    })
    const lookup = await loadQueueRowsForExpenseClaims(db, [AW('c1')])
    expect(lookup('c1').itemIds).toHaveLength(1001)
  })
})

describe('withExpenseLifecycle', () => {
  it('labels each claim', async () => {
    const db = mockDb({
      fte_expense_items: { data: [{ id: 'i1', claim_id: 'c1' }], error: null },
      invoices_queue: { data: [{ source_fte_expense_item_id: 'i1', status: 'forwarded', xero_bill_id: 'b', xero_bill_status: 'DRAFT' }], error: null },
    })
    const out = await withExpenseLifecycle(db, [AW('c1'), { id: 'c2', status: 'submitted' }])
    expect(out[0].lifecycle.label).toBe('Sent to Xero')
    expect(out[1].lifecycle.label).toBe('Awaiting review')
  })

  it('a thrown loader degrades to plain Approved', async () => {
    const db = { from: () => { throw new Error('boom') } }
    const out = await withExpenseLifecycle(db, [AW('c1')])
    expect(out[0].lifecycle.label).toBe('Approved')
  })
})
