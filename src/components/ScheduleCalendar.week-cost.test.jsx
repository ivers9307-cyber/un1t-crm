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
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC, name: 'Stillorgan' } }
const coach = { id: 'u2', role: 'staff', activeLocation: { id: LOC, name: 'Stillorgan' } }

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

beforeEach(() => { mockFetch(okResponse({ success: true, data: WEEK_COST })) })
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
})
