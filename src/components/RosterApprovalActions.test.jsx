// BUDGETAPPROVE.1 — the message an approver sees when approval re-projected
// the budget and the numbers had moved since the draft was submitted.

import { describe, it, expect, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const { projectionChangedMessage } = await import('./RosterApprovalActions')

describe('projectionChangedMessage', () => {
  it('names the current and submitted period cost, and each month over budget', () => {
    const msg = projectionChangedMessage({
      projection_changed: true,
      previous_projection: { projected_contractor_eur: 99.96, budget_at_publish_eur: 5000 },
      current_projection: { projected_contractor_eur: 689.95, budget_at_publish_eur: 5000 },
      impact: { months: [
        { monthStart: '2026-08-01', overrunEur: 0 },
        { monthStart: '2026-09-01', overrunEur: 25 },
      ] },
    })
    expect(msg).toContain('689.95')
    expect(msg).toContain('submitted as')
    expect(msg).toContain('99.96')
    expect(msg).toContain('2026-09:')
    expect(msg).not.toContain('2026-08:')
    // Budget unchanged, so no budget line.
    expect(msg).not.toContain('Monthly budget')
    expect(msg).not.toContain('—')
  })

  it('adds a budget line when the budget moved', () => {
    const msg = projectionChangedMessage({
      previous_projection: { projected_contractor_eur: 100, budget_at_publish_eur: null },
      current_projection: { projected_contractor_eur: 100, budget_at_publish_eur: 5000 },
    })
    expect(msg).toContain('Monthly budget')
    expect(msg).toContain('no budget')
  })
})
