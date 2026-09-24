// @vitest-environment jsdom
//
// ROSTERLOAD.1 (review S2) — when the calendar's coach list or leave failed to
// load, the summary panel must not state false things: an empty staff slice
// read "No FTE coaches assigned to this week yet.", and utilisation computed
// without leave could never show a coach as on leave. The calendar's own
// tests mock this panel out, so it is pinned here.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

import RosterSummaryPanel from '@/components/RosterSummaryPanel'

afterEach(cleanup)

const FTE = {
  id: 'c1', full_name: 'Full Timer', role: 'staff', active: true,
  employment_type: 'fte', contracted_hours_per_week: 30,
  profile_locations: [{ location_id: 'loc1' }],
}

function renderPanel(props) {
  return render(
    <RosterSummaryPanel blocks={[]} staff={[]} weekStart={new Date(2026, 4, 4)} timeOff={[]} contractorSpend={null} {...props} />,
  )
}

describe('RosterSummaryPanel with a slice missing', () => {
  it('coach list missing: says so, never "No FTE coaches assigned"', () => {
    renderPanel({ staffUnavailable: true })
    expect(screen.getByText('Coach list could not be loaded')).toBeTruthy()
    expect(screen.queryByText('No FTE coaches assigned to this week yet.')).toBeNull()
  })

  it('an empty coach list that DID load still says no FTE coaches (unchanged)', () => {
    renderPanel()
    expect(screen.getByText('No FTE coaches assigned to this week yet.')).toBeTruthy()
    expect(screen.queryByText('Coach list could not be loaded')).toBeNull()
  })

  it('leave missing: says utilisation does not include leave', () => {
    renderPanel({ staff: [FTE], leaveMissing: true })
    expect(screen.getByText('Leave not included')).toBeTruthy()
  })

  it('leave loaded: no such caveat', () => {
    renderPanel({ staff: [FTE] })
    expect(screen.queryByText('Leave not included')).toBeNull()
  })

  it('spend missing: "Could not be loaded", not an endless "Calculating…"', () => {
    renderPanel({ contractorSpendUnavailable: true })
    expect(screen.getByText('Could not be loaded')).toBeTruthy()
    expect(screen.queryByText('Calculating…')).toBeNull()
  })
})
