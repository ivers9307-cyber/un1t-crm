// @vitest-environment jsdom
//
// INVOICEHOURS.1 — two honest notes beside "Schedule vs invoice":
//   - the roster could not be read (so there is no comparison; never "0 h");
//   - hours on shifts in rosters that were not published (not counted).

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { RosterCheckNotes } from './InvoicesManager.jsx'

afterEach(cleanup)

describe('RosterCheckNotes', () => {
  it('unavailable on a submitted invoice: says so, and to refresh before approving', () => {
    render(<RosterCheckNotes data={{ status: 'submitted', roster_unavailable: true, review_comparison: null, computed_scheduled: null }} />)
    const alert = screen.getByRole('alert').textContent
    expect(alert).toMatch(/Could not read the roster for this period/)
    expect(alert).toMatch(/Refresh before approving/)
    expect(screen.queryByText(/0 h/)).toBeNull()
  })

  // Only a 'submitted' invoice can be approved (approve route 409s anything
  // else), so the approving advice is wrong on every other status.
  it('unavailable on an invoice past approval: a neutral line, no approving advice', () => {
    for (const status of ['awaiting_accountant_review', 'approved', 'declined', 'revoked']) {
      render(<RosterCheckNotes data={{ status, roster_unavailable: true, review_comparison: null, computed_scheduled: null }} />)
      const alert = screen.getByRole('alert').textContent
      expect(alert, status).toMatch(/Couldn't read the roster for this period\./)
      expect(alert, status).not.toMatch(/approv/i)
      cleanup()
    }
  })

  it('unavailable but an approval snapshot is showing: no alert (the snapshot is the record)', () => {
    const { container } = render(<RosterCheckNotes data={{
      roster_unavailable: true, review_comparison: { primary: { source: 'snapshot' } }, computed_scheduled: null,
    }} />)
    expect(container.textContent).toBe('')
  })

  it('unpublished line: names the hours and shifts left out', () => {
    render(<RosterCheckNotes data={{
      roster_unavailable: false, review_comparison: { primary: {} },
      computed_scheduled: { unpublished_hours: 2, unpublished_shift_count: 1 },
    }} />)
    expect(screen.getByText(/Not counted: 2 h on 1 shift in rosters that were not published/)).toBeTruthy()
  })

  it('plural shifts', () => {
    render(<RosterCheckNotes data={{ computed_scheduled: { unpublished_hours: 3.5, unpublished_shift_count: 3 } }} />)
    expect(screen.getByText(/3\.5 h on 3 shifts/)).toBeTruthy()
  })

  it('nothing to say: renders nothing', () => {
    const { container } = render(<RosterCheckNotes data={{
      roster_unavailable: false, review_comparison: { primary: {} },
      computed_scheduled: { unpublished_hours: 0, unpublished_shift_count: 0 },
    }} />)
    expect(container.textContent).toBe('')
  })
})
