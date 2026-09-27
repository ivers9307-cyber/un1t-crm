// @vitest-environment jsdom
//
// REPORTS.2 — the contractor-spend panel names the month it reports on, and
// when the visible week straddles two months it says which one it chose.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

import RosterSummaryPanel from '@/components/RosterSummaryPanel'

afterEach(cleanup)

const SPEND = {
  monthStartIso: '2026-09-01', monthEndIso: '2026-09-30',
  contractorCostEur: 1200, monthlyBudgetEur: 2000, remainingEur: 800, utilisationPct: 60,
  overBudget: false, fteImplicitCostEur: 0,
}

function renderPanel(props) {
  return render(
    <RosterSummaryPanel blocks={[]} staff={[]} weekStart={new Date(2026, 7, 31)} timeOff={[]} contractorSpend={SPEND} {...props} />,
  )
}

describe('RosterSummaryPanel contractor spend month', () => {
  it('labels the month it reports on', () => {
    renderPanel()
    expect(screen.getByText(/Contractor spend — September 2026/)).toBeTruthy()
    expect(screen.queryByText(/This week runs into/)).toBeNull()
  })

  it('says which month it chose for a straddling week', () => {
    renderPanel({ spendOtherMonthStart: '2026-08-01' })
    expect(screen.getByText('This week runs into August. Showing September, which has most of its days.')).toBeTruthy()
  })
})

// CONTRACTORSPEND.1 — the headline is PUBLISHED shifts; anything not yet
// published is one line beside it, so a month being drafted still shows where
// it is heading.
describe('RosterSummaryPanel contractor spend: published and not yet published', () => {
  it('labels the headline Published', () => {
    renderPanel()
    expect(screen.getByText('Published')).toBeTruthy()
    expect(screen.queryByText('Spent')).toBeNull()
  })

  it('says nothing about unpublished shifts when there are none (or an older server sent no figure)', () => {
    const { container } = renderPanel({ contractorSpend: { ...SPEND, unpublishedContractorCostEur: 0 } })
    expect(container.textContent).not.toMatch(/not yet published/)
    cleanup()
    const { container: old } = renderPanel()
    expect(old.textContent).not.toMatch(/not yet published/)
  })

  it('shows the unpublished amount when the month stays within budget', () => {
    const { container } = renderPanel({
      contractorSpend: { ...SPEND, unpublishedContractorCostEur: 300, projectedContractorCostEur: 1500, projectedOverBudget: false },
    })
    expect(container.textContent).toContain('€300 more in shifts not yet published.')
    expect(container.textContent).not.toMatch(/over budget once published/)
  })

  it('says how far over budget the month goes once published, when only the projection is over', () => {
    const { container } = renderPanel({
      contractorSpend: { ...SPEND, unpublishedContractorCostEur: 1300, projectedContractorCostEur: 2500, projectedOverBudget: true },
    })
    expect(container.textContent).toContain('€1,300 more in shifts not yet published: €500 over budget once published.')
  })

  it('does not repeat "over budget" when the published figure is already over', () => {
    const { container } = renderPanel({
      contractorSpend: {
        ...SPEND, contractorCostEur: 2100, remainingEur: -100, overBudget: true, utilisationPct: 105,
        unpublishedContractorCostEur: 200, projectedContractorCostEur: 2300, projectedOverBudget: true,
      },
    })
    expect(container.textContent).toContain('€200 more in shifts not yet published.')
    expect(container.textContent).not.toMatch(/over budget once published/)
  })

  // Amounts render to the whole euro: gate on what is SHOWN, never "€0 more".
  it('hides a sub-euro unpublished amount that would render as €0', () => {
    const { container } = renderPanel({ contractorSpend: { ...SPEND, unpublishedContractorCostEur: 0.3 } })
    expect(container.textContent).not.toMatch(/not yet published/)
  })

  it('shows an unpublished amount that rounds up to €1', () => {
    const { container } = renderPanel({ contractorSpend: { ...SPEND, unpublishedContractorCostEur: 0.6 } })
    expect(container.textContent).toContain('€1 more in shifts not yet published.')
  })

  it('drops the over-budget phrase when the overshoot would render as €0', () => {
    const { container } = renderPanel({
      contractorSpend: { ...SPEND, unpublishedContractorCostEur: 800.3, projectedContractorCostEur: 2000.3, projectedOverBudget: true },
    })
    expect(container.textContent).toContain('€800 more in shifts not yet published.')
    expect(container.textContent).not.toMatch(/over budget once published/)
  })

  it('shows an over-budget overshoot that rounds up to €1', () => {
    const { container } = renderPanel({
      contractorSpend: { ...SPEND, unpublishedContractorCostEur: 800.6, projectedContractorCostEur: 2000.6, projectedOverBudget: true },
    })
    expect(container.textContent).toContain('€801 more in shifts not yet published: €1 over budget once published.')
  })
})
