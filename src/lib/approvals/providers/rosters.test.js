// ROSTERPROV.1 — the roster approvals provider's overrun.
//
// It used to be `projected_contractor_eur - budget_at_publish_eur`: a WHOLE
// PERIOD's cost minus a MONTHLY budget. Since #1704 the projection is per
// month, and the subtraction was wrong in both directions — it over-reported
// a draft that crosses a month boundary (two months of cost against one
// month's budget) and under-reported one where another period was already
// published into the same month. Only the projection knows.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../registry', () => ({ viewerActiveLocationId: vi.fn(() => 'loc1') }))
vi.mock('@/lib/roster-publish', () => ({ projectPublishImpactBatch: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { projectPublishImpactBatch } = await import('@/lib/roster-publish')
const { logWarn } = await import('@/lib/log')
const { rostersProvider, rosterApprovalSubtitle } = await import('./rosters')

const DRAFT = {
  id: 'r-1',
  location_id: 'loc1',
  period_start: '2026-08-31',
  period_end: '2026-09-30',
  // The stored snapshot that produced the wrong number: €9,000 over the whole
  // period against a €5,000 MONTHLY budget read as "+€4,000 over".
  projected_contractor_eur: 9000,
  budget_at_publish_eur: 5000,
  created_at: '2026-08-30T10:00:00Z',
  published_by_profile: { id: 'p1', full_name: 'Colm' },
  location: { id: 'loc1', name: 'UN1T Stillorgan' },
}

function db(rows = [DRAFT]) {
  const b = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: async () => ({ data: rows, error: null }),
  }
  return { from: () => b }
}

beforeEach(() => { projectPublishImpactBatch.mockReset(); logWarn.mockReset() })

// The batch answers one { impact, error } per period, in input order.
function batchOf(...results) {
  projectPublishImpactBatch.mockResolvedValue(results)
}

describe('rosterApprovalSubtitle', () => {
  it('quotes the budget as MONTHLY, and the overrun from the projection', () => {
    expect(rosterApprovalSubtitle({
      publisher: 'Colm',
      impact: { periodProjectedEur: 9000, monthlyBudgetEur: 5000, overrunEur: 400, months: [{ monthStart: '2026-09-01', overrunEur: 400 }] },
      storedProjectedEur: 9000,
      storedBudgetEur: 5000,
    })).toBe('Published by Colm · €9,000 projected vs €5,000 monthly budget (+€400 over)')
  })

  it('names each month that is over when the period crosses a boundary', () => {
    expect(rosterApprovalSubtitle({
      publisher: 'Colm',
      impact: {
        periodProjectedEur: 9000, monthlyBudgetEur: 5000, overrunEur: 500,
        months: [
          { monthStart: '2026-08-01', overrunEur: 100 },
          { monthStart: '2026-09-01', overrunEur: 400 },
        ],
      },
      storedProjectedEur: 9000,
      storedBudgetEur: 5000,
    })).toBe('Published by Colm · €9,000 projected vs €5,000 monthly budget (+€500 over: €100 in 2026-08, €400 in 2026-09)')
  })

  it('says "within budget" rather than inventing an overrun from the stored columns', () => {
    expect(rosterApprovalSubtitle({
      publisher: 'Colm',
      impact: { periodProjectedEur: 9000, monthlyBudgetEur: 5000, overrunEur: 0, months: [] },
      storedProjectedEur: 9000,
      storedBudgetEur: 5000,
    })).toMatch(/\(within budget\)$/)
  })

  it('refuses to guess when the re-projection failed', () => {
    expect(rosterApprovalSubtitle({
      publisher: 'Colm', impact: null, storedProjectedEur: 9000, storedBudgetEur: 5000,
    })).toBe('Published by Colm · €9,000 projected vs €5,000 monthly budget (overrun could not be re-checked)')
  })
})

describe('rostersProvider.fetchPending', () => {
  it('re-projects the queue as ONE batch and reports the projection overrun, not period-minus-month', async () => {
    batchOf({
      impact: {
        periodProjectedEur: 9000, monthlyBudgetEur: 5000, overrunEur: 400,
        months: [{ monthStart: '2026-09-01', overrunEur: 400 }],
      },
      error: null,
    })
    const { items } = await rostersProvider.fetchPending(db(), { id: 'u1' })
    expect(projectPublishImpactBatch).toHaveBeenCalledTimes(1)
    expect(projectPublishImpactBatch).toHaveBeenCalledWith(expect.anything(), [
      { locationId: 'loc1', periodStart: '2026-08-31', periodEnd: '2026-09-30' },
    ])
    // NOT 4000 (9000 - 5000), which is what the stored columns gave.
    expect(items[0].amount).toBe(400)
    expect(items[0].subtitle).toContain('+€400 over')
  })

  // ROSTERTIDY.1 — the N+1 this replaced: 50 drafts used to be 50 full
  // context loads. Now it is one call carrying every draft, results matched
  // back by position.
  it('sends every draft in one call and maps results back by position', async () => {
    const second = { ...DRAFT, id: 'r-2', period_start: '2026-10-05', period_end: '2026-10-11' }
    batchOf(
      { impact: { periodProjectedEur: 9000, monthlyBudgetEur: 5000, overrunEur: 400, months: [] }, error: null },
      { impact: { periodProjectedEur: 900, monthlyBudgetEur: 5000, overrunEur: 0, months: [] }, error: null },
    )
    const { items } = await rostersProvider.fetchPending(db([DRAFT, second]), { id: 'u1' })
    expect(projectPublishImpactBatch).toHaveBeenCalledTimes(1)
    expect(projectPublishImpactBatch.mock.calls[0][1]).toHaveLength(2)
    expect(items.map((i) => [i.id, i.amount])).toEqual([['r-1', 400], ['r-2', null]])
  })

  it('still lists the draft, and says the overrun could not be re-checked, when its projection fails', async () => {
    batchOf({ impact: null, error: new Error('block lookup failed') })
    const { count, items } = await rostersProvider.fetchPending(db(), { id: 'u1' })
    expect(count).toBe(1)
    expect(items[0].amount).toBeNull()
    expect(items[0].subtitle).toContain('could not be re-checked')
    expect(logWarn).toHaveBeenCalledWith('approvals/rosters', expect.any(String), expect.objectContaining({ roster_id: 'r-1', err: 'block lookup failed' }))
  })

  it('still lists every draft if the batch itself throws', async () => {
    projectPublishImpactBatch.mockRejectedValue(new Error('boom'))
    const { count, items } = await rostersProvider.fetchPending(db(), { id: 'u1' })
    expect(count).toBe(1)
    expect(items[0].subtitle).toContain('could not be re-checked')
  })

  it('carries no amount for a draft that is no longer over budget', async () => {
    batchOf({ impact: { periodProjectedEur: 900, monthlyBudgetEur: 5000, overrunEur: 0, months: [] }, error: null })
    const { items } = await rostersProvider.fetchPending(db(), { id: 'u1' })
    expect(items[0].amount).toBeNull()
  })
})
