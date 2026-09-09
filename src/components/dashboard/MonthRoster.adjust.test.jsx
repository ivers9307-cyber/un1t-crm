// @vitest-environment jsdom
//
// ROSTER-FIX.3 (D3) — the Today roster is a COACH surface, and a coach is
// paid for a window a manager set. The shift action menu used to offer
// "Adjust time" (and a "Clear override" escape hatch) straight to the coach;
// PUT /api/schedule/assignments/[id] now 403s that, so the menu must not
// offer it either — a menu item that always fails is worse than no menu item.
//
// What survives is the swap pair (the coach's real way out of a shift) and
// the "(adjusted)" marker, so a coach can still SEE a manager moved them.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MonthRoster from './MonthRoster'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const shift = {
  id: 'assign-1',
  status: 'scheduled',
  profile_id: 'coach-1',
  location_id: 'loc-1',
  start_time_override: '10:00:00',
  end_time_override: '12:00:00',
  shift_templates: { name: 'Morning', start_time: '09:00:00', end_time: '13:00:00' },
}

// One future day carrying one shift, in the shape MonthGrid/CalCell expect.
const weeks = [[
  { iso: '2099-06-10', dayNum: 10, inMonth: true, isToday: false, isPast: false, shifts: [shift] },
]]

function openTheShiftMenu() {
  render(<MonthRoster weeks={weeks} monthLabel="June 2099" monthSummary="1 shift · 2h" weekPanels={[]} />)
  fireEvent.click(screen.getByRole('button', { name: /morning/i }))
}

afterEach(() => cleanup())

describe('MonthRoster shift action menu — a coach cannot adjust their own hours', () => {
  it('offers no "Adjust time" action', () => {
    openTheShiftMenu()
    expect(screen.queryByText(/adjust time/i)).toBeNull()
  })

  it('offers no "Clear override" escape hatch', () => {
    openTheShiftMenu()
    expect(screen.queryByText(/clear override/i)).toBeNull()
  })

  it('still offers both swap routes', () => {
    openTheShiftMenu()
    expect(screen.getByText(/post for swap/i)).toBeTruthy()
    expect(screen.getByText(/swap with a specific coach/i)).toBeTruthy()
  })

  it('still shows the coach that their hours were adjusted', () => {
    openTheShiftMenu()
    expect(screen.getByText(/\(adjusted\)/i)).toBeTruthy()
  })

  it('tells the coach who sets the hours', () => {
    openTheShiftMenu()
    expect(screen.getByText(/set by your manager/i)).toBeTruthy()
  })
})
