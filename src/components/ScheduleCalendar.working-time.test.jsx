// @vitest-environment jsdom
//
// WORKTIME.1 — the working-time advisory reaches the publish preview's list.
// (The assign picker's rest and week badges come from CANDIDATES.1's ranked
// answer now: src/components/ScheduleCalendar.candidates.test.jsx.) The rules
// are pinned in shared/working-time.test.js and the read in
// src/lib/working-time-data.test.js. This file is the wiring, and that it stays
// ADVISORY: Publish stays enabled. jsdom has no layout, so only text, roles and
// presence are asserted.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// The preview waits up to 5s for the modal's dry run; the file's budget must
// sit above that (tests/test-timeout-budgets.test.js).
vi.setConfig({ testTimeout: 20000 })

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const user = {
  id: 'u1', role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC]: 'manager' },
  activeLocation: { id: LOC, name: 'Studio North' },
}

// Wednesday of the week the URL pins.
const targetBlock = {
  id: 'b-target', location_id: LOC, template_id: 't2', block_date: '2026-05-06',
  start_time: '10:00:00', end_time: '12:00:00', max_coaches: 3, min_coaches: 1,
  shift_templates: { id: 't2', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [],
}

const staff = [
  { id: 'c-rest', full_name: 'Rest Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-week', full_name: 'Week Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-free', full_name: 'Free Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]

const BASE_IMPACT = {
  blockCount: 1, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: null,
  overBudget: false, overrunEur: 0, months: [], staffingGaps: [],
  leaveClashes: [], doubleBookings: [], crossLocationChecked: true,
}
const WORKING_TIME = {
  checked: true,
  longWeeks: [{ profile_id: 'c-week', coach_name: 'Week Coach', week_start: '2026-05-04', minutes: 2910, shift_count: 6, studio_count: 2 }],
  restGaps: [{
    profile_id: 'c-rest', coach_name: 'Rest Coach', rest_minutes: 570,
    before: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' },
    after: { block_id: 'b-target', date: '2026-05-06', start: '07:00', end: '09:00', name: 'Early', location_name: null },
  }],
}

function okResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

function mockFetch({ impact = { ...BASE_IMPACT, workingTime: WORKING_TIME } } = {}) {
  return vi.fn(async (url, opts) => {
    const u = String(url)
    if (u.includes('/schedule/rosters') && opts?.method === 'POST') return okResponse({ success: true, impact })
    if (u.includes('/schedule/blocks')) return okResponse({ success: true, data: [targetBlock] })
    if (u.includes('/api/staff')) return okResponse({ success: true, data: staff })
    return okResponse({ success: true, data: [] })
  })
}

async function openPublishPreview() {
  render(<ScheduleCalendar user={user} />)
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
  fireEvent.click(screen.getByText('Publish'))
  await screen.findByText('Blocks in period', {}, { timeout: 5000 })
}

beforeEach(() => { global.fetch = mockFetch() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('publish preview: working time (WORKTIME.1)', () => {
  it('lists long weeks and short rests with names, hours and the other studio, and Publish stays enabled', async () => {
    await openPublishPreview()
    const box = screen.getByTestId('publish-working-time')
    const text = box.textContent
    expect(text).toMatch(/1 employee over 48 hours in a week/)
    expect(text).toMatch(/Week Coach/)
    expect(text).toMatch(/48h 30m rostered/)
    expect(text).toMatch(/across 2 studios/)
    expect(text).toMatch(/1 rest under 11 hours between working days/)
    expect(text).toMatch(/Rest Coach/)
    expect(text).toMatch(/ends 9:30pm \(Studio South\)/)
    expect(text).toMatch(/starts 7am/)
    expect(text).toMatch(/9h 30m rest/)
    expect(text).not.toMatch(/€/)
    const publishButtons = screen.getAllByRole('button', { name: 'Publish' })
    expect(publishButtons[publishButtons.length - 1].disabled).toBe(false)
  })

  it('says so when the check could not be completed, rather than implying an all-clear', async () => {
    global.fetch = mockFetch({ impact: { ...BASE_IMPACT, workingTime: { restGaps: [], longWeeks: [], checked: false } } })
    await openPublishPreview()
    expect(screen.getByTestId('publish-working-time').textContent).toMatch(/The working-time check could not be completed\./)
  })

  it('renders nothing when there is nothing to say', async () => {
    global.fetch = mockFetch({ impact: { ...BASE_IMPACT, workingTime: { restGaps: [], longWeeks: [], checked: true } } })
    await openPublishPreview()
    expect(screen.queryByTestId('publish-working-time')).toBeNull()
  })

  it('renders nothing for an older server that does not send it', async () => {
    global.fetch = mockFetch({ impact: BASE_IMPACT })
    await openPublishPreview()
    expect(screen.queryByTestId('publish-working-time')).toBeNull()
  })
})

describe('shifts without times (WORKTIME.1 review)', () => {
  it('the publish preview says how many shifts it could not count, even with nothing else to list', async () => {
    global.fetch = mockFetch({ impact: { ...BASE_IMPACT, workingTime: { restGaps: [], longWeeks: [], checked: true, untimed: 2 } } })
    await openPublishPreview()
    expect(screen.getByTestId('publish-working-time').textContent).toMatch(/2 shifts without times were not counted\./)
  })
})
