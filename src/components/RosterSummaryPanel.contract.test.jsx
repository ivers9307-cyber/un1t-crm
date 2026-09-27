// @vitest-environment jsdom
//
// CONTRACTVIS.1 — the FTE half measures each coach against their contract, and
// a colleague's contract is owner / manager / master only. Without
// `contractVisible` (a head coach's calendar) the half lists rostered hours
// only: no contract, no percentage, no status. It defaults to hidden.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

import RosterSummaryPanel from '@/components/RosterSummaryPanel'

afterEach(cleanup)

const FTE = {
  id: 'c1', full_name: 'Coach One', role: 'staff', active: true,
  employment_type: 'fte', contracted_hours_per_week: 30,
  profile_locations: [{ location_id: 'loc1' }],
}
const FTE_TWO = { id: 'c2', full_name: 'Coach Two', role: 'staff', active: true, employment_type: 'fte', profile_locations: [{ location_id: 'loc1' }] }

// Mon 4 May 2026 onwards: Coach One 7 × 5h = 35h, Coach Two 1 × 5h.
const blk = (id, date, pid) => ({
  id, location_id: 'loc1', block_date: date, start_time: '09:00', end_time: '14:00',
  shift_templates: { start_time: '09:00', end_time: '14:00' },
  shift_assignments: [{ id: `a-${id}`, profile_id: pid }],
})
const DAYS = ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10']
const BLOCKS = [...DAYS.map((d, i) => blk(`b${i}`, d, 'c1')), blk('b9', '2026-05-05', 'c2')]

function renderPanel(props) {
  return render(
    <RosterSummaryPanel blocks={BLOCKS} staff={[FTE, FTE_TWO]} weekStart={new Date(2026, 4, 4)} timeOff={[]} contractorSpend={null} {...props} />,
  )
}

describe('RosterSummaryPanel — contract visibility', () => {
  it('contractVisible: utilisation against the contract, as before', () => {
    renderPanel({ contractVisible: true })
    expect(screen.getByText('FTE utilisation — this week')).toBeTruthy()
    expect(screen.getByText(/35h \/ 30h/)).toBeTruthy()
    expect(screen.getByText('Over hours')).toBeTruthy()
  })

  it('default (hidden): hours only, heaviest first, no contract, % or status', () => {
    renderPanel()
    expect(screen.getByText('FTE hours — this week')).toBeTruthy()
    expect(screen.queryByText(/\/ 30h/)).toBeNull()
    expect(screen.queryByText(/%/)).toBeNull()
    for (const label of ['Over hours', 'On target', 'Underused', 'No contract']) expect(screen.queryByText(label)).toBeNull()
    const names = screen.getAllByText(/^Coach (One|Two)$/).map((n) => n.textContent)
    expect(names).toEqual(['Coach One', 'Coach Two'])
    expect(screen.getByText('35h')).toBeTruthy()
    expect(screen.getByText('5h')).toBeTruthy()
    expect(screen.getByText('Contracted hours are shown to owners and managers.')).toBeTruthy()
  })

  it('hidden: no "Leave not included" pill (it qualifies a contract comparison)', () => {
    renderPanel({ leaveMissing: true })
    expect(screen.queryByText('Leave not included')).toBeNull()
  })
})
