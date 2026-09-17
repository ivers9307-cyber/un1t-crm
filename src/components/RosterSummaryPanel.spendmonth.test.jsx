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
