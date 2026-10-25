// @vitest-environment jsdom
//
// ROSTER-FIX.6c — the FTE hours panel reads the server, not pay fields.
//
// The point of the move is that annual_salary / hourly_rate / overtime_rate no
// longer have to be in the browser for this panel to render. So the /api/staff
// double here serves the pay-free shape, and the panel is still expected to be
// right — which it can only be if it is reading /api/schedule/week-cost.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
const panel = vi.hoisted(() => ({ props: null }))
vi.mock('./RosterSummaryPanel', () => ({ default: (p) => { panel.props = p; return null } }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const OTHER = 'loc2'
// Fixtures carry profileRole + rolesByLocation, as getCurrentUser does: the
// calendar judges contract visibility AT the studio on screen (CONTRACTVIS.1).
const at = (id, role, extra = {}) => ({
  id, role, profileRole: role, activeLocation: { id: LOC, name: 'Stillorgan' }, rolesByLocation: { [LOC]: role }, ...extra,
})
const manager = at('u1', 'manager')
const coach = at('u2', 'staff')
const headCoach = at('u3', 'head_coach')
const master = { id: 'u4', role: 'master', profileRole: 'master', activeLocation: { id: LOC, name: 'Stillorgan' }, rolesByLocation: {} }

// The slim /api/staff shape — no annual_salary, no hourly_rate, no
// overtime_rate. This is what a non-admin manager actually receives.
const slimStaff = [
  { id: 'p1', full_name: 'Sarah FTE', role: 'staff', active: true, employment_type: 'fte', profile_locations: [{ location_id: LOC }] },
]

const WEEK_COST = {
  weekStartIso: '2026-05-04',
  weekEndIso: '2026-05-10',
  coaches: [
    { profile_id: 'p1', full_name: 'Sarah FTE', allocated_hours: 34, contracted_hours: 30, overtime_hours: 4, status: 'overtime', over_threshold: true },
    { profile_id: 'p2', full_name: 'Ann FTE', allocated_hours: 12, contracted_hours: 30, overtime_hours: 0, status: 'under', over_threshold: false },
  ],
  totals: { coaches: 2, allocated_hours: 46, overtime_hours: 4, over_threshold: 1 },
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

let calls
function mockFetch(weekCostBody) {
  calls = []
  global.fetch = vi.fn(async (url) => {
    calls.push(url)
    if (url.includes('/schedule/week-cost')) return weekCostBody
    if (url.includes('/api/staff')) return okResponse({ success: true, data: slimStaff })
    return okResponse({ success: true, data: [] })
  })
}

beforeEach(() => { panel.props = null; mockFetch(okResponse({ success: true, data: WEEK_COST })) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('weekly hours panel (ROSTER-FIX.6c)', () => {
  it('renders the server hours without any pay field in the browser', async () => {
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.getByText('Weekly hours notice')).toBeTruthy())
    expect(screen.getByText('34.0h / 30h')).toBeTruthy()
    expect(screen.getByText('+4.0h OT')).toBeTruthy()
    expect(JSON.stringify(slimStaff)).not.toMatch(/salary|hourly_rate|overtime_rate/)
  })

  it('asks the endpoint for the visible week', async () => {
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.getByText('Weekly hours notice')).toBeTruthy())
    expect(calls.some((u) => u === `/api/schedule/week-cost?location_id=${LOC}&week_start=2026-05-04`)).toBe(true)
  })

  it('leaves out a coach under their contract', async () => {
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.getByText('Weekly hours notice')).toBeTruthy())
    expect(screen.queryByText(/Ann FTE/)).toBeNull()
  })

  it('a failed hours fetch hides the panel and leaves the roster alone', async () => {
    mockFetch({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByText('Weekly hours notice')).toBeNull()
    // The roster's own banner is what a broken roster looks like; this is not that.
    expect(screen.queryByText('Could not load the roster')).toBeNull()
  })

  it('never asks for a coach, who would only get a 403', async () => {
    render(<ScheduleCalendar user={coach} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(calls.some((u) => u.includes('/schedule/week-cost'))).toBe(false)
  })

  // CONTRACTVIS.1 — the notice is a colleague's contract; a head coach does
  // not ask for it, does not see it, and does not ask /api/staff for contracts.
  it('a head coach never asks for week-cost and never sees the notice', async () => {
    render(<ScheduleCalendar user={headCoach} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(calls.some((u) => u.includes('/schedule/week-cost'))).toBe(false)
    expect(screen.queryByText('Weekly hours notice')).toBeNull()
  })

  it('a manager asks /api/staff for contracts and the panel may show them', async () => {
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.getByText('Weekly hours notice')).toBeTruthy())
    const staffUrls = calls.filter((u) => u.includes('/api/staff'))
    expect(staffUrls.length).toBeGreaterThan(0)
    expect(staffUrls.every((u) => u.includes('include=contract'))).toBe(true)
    expect(panel.props?.contractVisible).toBe(true)
  })

  it('a head coach never asks /api/staff for contracts and the panel shows hours only', async () => {
    render(<ScheduleCalendar user={headCoach} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    const staffUrls = calls.filter((u) => u.includes('/api/staff'))
    expect(staffUrls.length).toBeGreaterThan(0)
    expect(staffUrls.some((u) => u.includes('include=contract'))).toBe(false)
    expect(panel.props?.contractVisible).toBe(false)
  })
})

// CONTRACTVIS.1 review — the calendar asks hasRoleAtLocation(user, <the
// calendar's studio>, ADMIN_ROLES), as SCHEDROLES does, not
// ADMIN_ROLES.includes(user.role). Today the two agree (the calendar shows the
// active studio); the per-studio check survives a future switcher, and a
// user.role that fell back to a role held at ANOTHER studio.
describe('who the calendar treats as seeing contracts (CONTRACTVIS.1)', () => {
  const visible = async (user) => {
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(panel.props).not.toBeNull())
    return panel.props.contractVisible
  }

  it('a manager at the active studio: true', async () => {
    expect(await visible(manager)).toBe(true)
  })

  it('a head coach at the active studio: false', async () => {
    expect(await visible(headCoach)).toBe(false)
  })

  it('a master (no per-studio rows): true', async () => {
    expect(await visible(master)).toBe(true)
  })

  it('manager elsewhere, head coach here: false, whatever user.role says', async () => {
    // user.role reads 'manager' by fallback to the highest role held anywhere;
    // the role AT this studio is what decides.
    const mixed = { ...headCoach, role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC]: 'head_coach', [OTHER]: 'manager' } }
    expect(await visible(mixed)).toBe(false)
    expect(calls.some((u) => u.includes('/schedule/week-cost'))).toBe(false)
  })
})
