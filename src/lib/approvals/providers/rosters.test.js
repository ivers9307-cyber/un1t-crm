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
vi.mock('@/lib/roster-publish', () => ({ projectPublishImpact: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { projectPublishImpact } = await import('@/lib/roster-publish')
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

beforeEach(() => { projectPublishImpact.mockReset() })

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
  it('re-projects per draft and reports the projection overrun, not period-minus-month', async () => {
    projectPublishImpact.mockResolvedValue({
      periodProjectedEur: 9000, monthlyBudgetEur: 5000, overrunEur: 400,
      months: [{ monthStart: '2026-09-01', overrunEur: 400 }],
    })
    const { items } = await rostersProvider.fetchPending(db(), { id: 'u1' })
    expect(projectPublishImpact).toHaveBeenCalledWith(expect.anything(), {
      locationId: 'loc1', periodStart: '2026-08-31', periodEnd: '2026-09-30',
    })
    // NOT 4000 (9000 - 5000), which is what the stored columns gave.
    expect(items[0].amount).toBe(400)
    expect(items[0].subtitle).toContain('+€400 over')
  })

  it('still lists the draft when its projection throws', async () => {
    projectPublishImpact.mockRejectedValue(new Error('block lookup failed'))
    const { count, items } = await rostersProvider.fetchPending(db(), { id: 'u1' })
    expect(count).toBe(1)
    expect(items[0].amount).toBeNull()
    expect(items[0].subtitle).toContain('could not be re-checked')
  })

  it('carries no amount for a draft that is no longer over budget', async () => {
    projectPublishImpact.mockResolvedValue({
      periodProjectedEur: 900, monthlyBudgetEur: 5000, overrunEur: 0, months: [],
    })
    const { items } = await rostersProvider.fetchPending(db(), { id: 'u1' })
    expect(items[0].amount).toBeNull()
  })
})
