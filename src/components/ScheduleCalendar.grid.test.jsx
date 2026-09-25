// @vitest-environment jsdom
//
// GRID.1 — the Coaches layout's wiring in the calendar: the toggle, the
// per-viewer memory, the read (only while the grid is shown), the block dialog
// from a grid shift, and the coach boundary. The grid's rules are pinned in
// src/lib/roster-grid-model.test.js and its markup in RosterGrid.test.jsx.
// jsdom has no layout: only presence, roles and text are asserted.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const manager = {
  id: 'u1', role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC]: 'manager' },
  activeLocation: { id: LOC, name: 'Studio North' },
}
const coach = {
  id: 'u2', role: 'staff', profileRole: 'staff', rolesByLocation: { [LOC]: 'staff' },
  activeLocation: { id: LOC, name: 'Studio North' },
}
const KEY = (id) => `un1t.schedule.layout.${id}`

// Wednesday of the week the URL pins.
const targetBlock = {
  id: 'b-target', location_id: LOC, template_id: 't2', block_date: '2026-05-06',
  start_time: '10:00:00', end_time: '12:00:00', max_coaches: 3, min_coaches: 1,
  shift_templates: { id: 't2', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [{ id: 'a1', profile_id: 'c-a', status: 'scheduled', profiles: { full_name: 'Alex Example' } }],
}
const staff = [{ id: 'c-a', full_name: 'Alex Example', role: 'staff', active: true, employment_type: 'fte', contracted_hours_per_week: 10, profile_locations: [{ location_id: LOC }] }]
const GRID = {
  week_start: '2026-05-04', week_end: '2026-05-10',
  members: [{ profile_id: 'c-a', full_name: 'Alex Example', employment_type: 'fte', contracted_hours: 10, member: true }],
  shifts: [{
    assignment_id: 'a1', profile_id: 'c-a', status: 'scheduled', block_id: 'b-target', block_date: '2026-05-06',
    location_id: LOC, location_name: 'Studio North', here: true, kind: 'class', name: 'Midday Strength',
    start_time: '10:00:00', end_time: '12:00:00', start_time_override: null, end_time_override: null,
    shift_templates: { start_time: '10:00:00', end_time: '12:00:00' },
  }],
  contract_visible: true,
  cross_studio_checked: true,
}
const GRID_URL = `/api/schedule/grid?location_id=${LOC}&start_date=2026-05-04`

const ok = (body, status = 200) => ({ ok: status < 400, status, redirected: false, json: async () => body })
function mockFetch(grid = GRID) {
  return vi.fn(async (url) => {
    const u = String(url)
    if (u.startsWith('/api/schedule/grid')) return ok({ success: true, data: grid })
    if (u.includes('/schedule/blocks')) return ok({ success: true, data: [targetBlock] })
    if (u.includes('/api/staff')) return ok({ success: true, data: staff })
    return ok({ success: true, data: [] })
  })
}
const gridCalls = () => global.fetch.mock.calls.filter(([u]) => String(u).startsWith('/api/schedule/grid'))

async function renderLoaded(user = manager) {
  render(<ScheduleCalendar user={user} />)
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
}

beforeEach(() => {
  global.fetch = mockFetch()
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('ScheduleCalendar: the Coaches layout (GRID.1)', () => {
  it('a manager whose last layout was Coaches gets the grid for the week on screen, not the day cards', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    const grid = await screen.findByTestId('roster-grid')
    expect(gridCalls().map(([u]) => String(u))).toContain(GRID_URL)
    expect(within(grid).getByRole('rowheader').textContent).toMatch(/Alex Example/)
    expect(within(grid).getByTestId('grid-week-total').textContent).toMatch(/^2h/)
    expect(within(grid).getByTestId('grid-contract').textContent).toBe('10h')
    expect(within(grid).getByTestId('grid-balance').textContent).toMatch(/^8h/)
    expect(screen.queryByText('Add Slot')).toBeNull()
    expect(screen.getByRole('button', { name: 'Coaches' }).getAttribute('aria-pressed')).toBe('true')
  })

  // GRID.1 review 1 — what the route sends a head coach: the grid, no contract.
  it('a head coach gets the grid with Contract and Admin balance hidden', async () => {
    const headCoach = { ...manager, id: 'u3', role: 'head_coach', profileRole: 'head_coach', rolesByLocation: { [LOC]: 'head_coach' } }
    const { contracted_hours: _c, ...member } = GRID.members[0]
    global.fetch = mockFetch({ ...GRID, contract_visible: false, members: [member] })
    window.localStorage.setItem(KEY('u3'), 'coaches')
    await renderLoaded(headCoach)
    const grid = await screen.findByTestId('roster-grid')
    expect(within(grid).getByTestId('grid-week-total').textContent).toMatch(/^2h/)
    expect(within(grid).getByTestId('grid-contract').textContent).toBe('—hidden')
    expect(within(grid).getByTestId('grid-balance').textContent).toBe('—hidden')
    expect(grid.textContent).not.toMatch(/No contract hours|to place/)
  })

  // GRID.1 review 2 — moving to the next week never lays this week's grid
  // under the new dates. Here the server (wrongly) answers the next week with
  // this week's grid: the screen must not draw it (no table, no 0h rows).
  it('the next week never shows the previous week\'s grid under its dates', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    await screen.findByTestId('roster-grid')
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(gridCalls().map(([u]) => String(u))).toContain(`/api/schedule/grid?location_id=${LOC}&start_date=2026-05-11`))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByTestId('roster-grid')).toBeNull()
    expect(screen.getByTestId('roster-grid-loading')).toBeTruthy()
    expect(screen.queryByText('Alex Example')).toBeNull()
  })

  it('a shift in the grid opens the same block dialog a day card opens', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    const grid = await screen.findByTestId('roster-grid')
    fireEvent.click(within(grid).getByRole('button', { name: /10am–12pm/ }))
    expect(await screen.findByRole('dialog', { name: 'Midday Strength' })).toBeTruthy()
  })

  // The grid is its own read, so every roster edit must re-read it
  // (refreshAfterMutation), or the totals and balances go stale under an edit.
  it('an edit made from a grid shift re-reads the grid', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderLoaded()
    const grid = await screen.findByTestId('roster-grid')
    await waitFor(() => expect(gridCalls()).toHaveLength(1))
    fireEvent.click(within(grid).getByRole('button', { name: /10am–12pm/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Midday Strength' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Alex Example from this shift' }))
    await waitFor(() => expect(gridCalls()).toHaveLength(2))
    expect(global.fetch.mock.calls.some(([u, init]) => String(u) === '/api/schedule/assignments/a1' && init?.method === 'DELETE')).toBe(true)
  })

  it('in select mode a grid shift toggles its selection instead of opening the dialog', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    const grid = await screen.findByTestId('roster-grid')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Select multiple' }))
    const chip = within(grid).getByRole('button', { name: /10am–12pm/ })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('dialog', { name: 'Midday Strength' })).toBeNull()
    expect(screen.getByText('1 shift selected')).toBeTruthy()
  })

  it('Days | Coaches switches the layout and remembers it for this viewer', async () => {
    await renderLoaded()
    expect(screen.getAllByText('Add Slot').length).toBeGreaterThan(0)
    expect(gridCalls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Coaches' }))
    await screen.findByTestId('roster-grid')
    expect(window.localStorage.getItem(KEY('u1'))).toBe('coaches')
    fireEvent.click(screen.getByRole('button', { name: 'Days' }))
    await waitFor(() => expect(screen.queryByTestId('roster-grid')).toBeNull())
    expect(screen.getAllByText('Add Slot').length).toBeGreaterThan(0)
    expect(window.localStorage.getItem(KEY('u1'))).toBe('days')
  })

  it('a coach gets neither the control nor a grid request, whatever was stored', async () => {
    window.localStorage.setItem(KEY('u2'), 'coaches')
    await renderLoaded(coach)
    expect(screen.queryByRole('group', { name: 'Roster layout' })).toBeNull()
    expect(screen.queryByTestId('roster-grid')).toBeNull()
    expect(gridCalls()).toHaveLength(0)
  })

  it('Month view has no Coaches layout; back to Week brings the grid back', async () => {
    window.localStorage.setItem(KEY('u1'), 'coaches')
    await renderLoaded()
    await screen.findByTestId('roster-grid')
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Roster layout' })).toBeNull())
    expect(screen.queryByTestId('roster-grid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    expect(await screen.findByTestId('roster-grid')).toBeTruthy()
  })

  it('a browser that refuses storage gets Days, and the control still works for the visit', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    await renderLoaded()
    expect(screen.getAllByText('Add Slot').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Coaches' }))
    expect(await screen.findByTestId('roster-grid')).toBeTruthy()
  })
})
