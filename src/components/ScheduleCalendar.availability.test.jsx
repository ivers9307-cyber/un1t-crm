// @vitest-environment jsdom
//
// AVAIL.1 — a manager's week view shades a coach's unavailable windows beside
// the leave bars, and the assign picker badges them. Advisory: the row stays
// tickable. A coach's calendar never asks for availability at all. No fake
// timers anywhere in this file.
//
// CANDIDATES.1 moved the picker badge's SOURCE: it is the server's ranked
// answer (GET /api/schedule/blocks/[id]/candidates, judged against the
// effective window), not the rules the calendar loaded for its shading. The
// words and the title are unchanged. The shading still reads the calendar's
// rules.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// See ScheduleCalendar.errors.test.jsx: the budget exceeds the waits below.
vi.setConfig({ testTimeout: 20000 })

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC, name: 'Studio A' } }
const coachUser = { id: 'u2', role: 'staff', activeLocation: { id: LOC, name: 'Studio A' } }
const DATE = '2026-05-06' // Wednesday

const block = {
  id: 'b1', location_id: LOC, template_id: 't1', block_date: DATE, start_time: '10:00:00', end_time: '12:00:00', max_coaches: 3,
  shift_templates: { id: 't1', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [],
}
const staff = [
  { id: 'c-busy', full_name: 'Busy Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-free', full_name: 'Free Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]
const availability = [
  { id: 'av1', profile_id: 'c-busy', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: 'School run' },
]

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

// The server's answer for the picker: Busy Coach has a rule touching the
// shift, Free Coach is free. `over` patches the answer per test.
const free = { free: true, busy: null, on_leave: null, unavailable: null, on_site: null, rest_gap: null, week_over: null, contracted_hours: null, week_minutes: 0 }
function candidatesAnswer({ busyUnavailable = { summary: '10am–11am', detail: 'Wednesdays, 10am–11am (School run)' }, checked = {} } = {}) {
  return {
    success: true,
    data: {
      audience: 'manager', block_id: 'b1', untimed: 0,
      checked: { shifts: true, cross_studio: true, leave: true, availability: true, contract: true, ...checked },
      candidates: [
        { ...free, profile_id: 'c-free', full_name: 'Free Coach', role: 'staff', rank: 1, tier: 'ready' },
        { ...free, profile_id: 'c-busy', full_name: 'Busy Coach', role: 'staff', rank: 2, tier: busyUnavailable ? 'unavailable' : 'ready', unavailable: busyUnavailable },
      ],
    },
  }
}
let answer = candidatesAnswer()

// "Today" is the Wednesday on screen, so weekly rules are drawn (they are
// drawn from today on only). Only Date is faked: RTL's findBy/waitFor keep
// the real timers, so no clock is advanced anywhere in this file.
const setToday = (y, m, d) => vi.setSystemTime(new Date(y, m - 1, d, 12, 0, 0))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  setToday(2026, 5, 6)
  answer = candidatesAnswer()
  global.fetch = vi.fn(async (url) => {
    // Before '/schedule/blocks': the candidates URL contains it too.
    if (url.includes('/candidates')) return ok(answer)
    if (url.includes('/schedule/availability')) return ok({ success: true, data: availability })
    if (url.includes('/schedule/blocks')) return ok({ success: true, data: [block] })
    if (url.includes('/api/staff')) return ok({ success: true, data: staff })
    return ok({ success: true, data: [] })
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

async function openAssignPicker(user = manager) {
  render(<ScheduleCalendar user={user} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }))
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
  fireEvent.click(screen.getByText('Add coach'))
  await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
}

describe("availability on the manager's week view (AVAIL.1)", () => {
  it('shades the unavailable coach on that day, with the note in the title', async () => {
    render(<ScheduleCalendar user={manager} />)
    const bar = await screen.findByText('Busy · Unavailable 10am–11am')
    expect(bar.closest('[data-testid="unavailable-bar"]').getAttribute('title'))
      .toBe('Busy Coach: unavailable Wednesdays, 10am–11am (School run)')
    expect(screen.getAllByTestId('unavailable-bar')).toHaveLength(1) // only Wednesday
  })

  it("reads as its own thing, not as SHIFTTYPE's slate admin card", async () => {
    render(<ScheduleCalendar user={manager} />)
    const bar = (await screen.findByText('Busy · Unavailable 10am–11am')).closest('[data-testid="unavailable-bar"]')
    expect(bar.className).not.toMatch(/bg-slate-500\/10/)
    expect(bar.className).toMatch(/border-dashed/)
  })

  it('a weekly rule is not drawn on a day already gone; a dated one still is', async () => {
    setToday(2026, 5, 7) // Thursday: Wednesday is past
    const dated = { id: 'av2', profile_id: 'c-free', kind: 'dated', weekday: null, start_date: DATE, end_date: DATE, all_day: true, start_time: null, end_time: null, note: null }
    const base = global.fetch
    global.fetch = vi.fn(async (url) => (url.includes('/schedule/availability')
      ? ok({ success: true, data: [...availability, dated] })
      : base(url)))
    render(<ScheduleCalendar user={manager} />)
    await screen.findByText('Free · Unavailable all day')
    expect(screen.getAllByTestId('unavailable-bar')).toHaveLength(1)
    expect(screen.queryByText(/^Busy · Unavailable/)).toBeNull()
  })

  it('a coach with a leave bar that day is not drawn twice', async () => {
    const leave = { id: 'to1', profile_id: 'c-busy', type: 'holiday', status: 'approved', start_date: DATE, end_date: DATE, profiles: { full_name: 'Busy Coach' } }
    const base = global.fetch
    global.fetch = vi.fn(async (url) => (url.includes('/schedule/time-off') ? ok({ success: true, data: [leave] }) : base(url)))
    render(<ScheduleCalendar user={manager} />)
    await screen.findByTestId('leave-bar')
    expect(screen.queryByTestId('unavailable-bar')).toBeNull()
  })

  it('badges the coach in the picker, and the row can still be ticked', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('Unavailable: 10am–11am')
    expect(badge.getAttribute('title')).toBe('Wednesdays, 10am–11am (School run)')
    const checkbox = badge.closest('label').querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Free Coach').closest('li').textContent).not.toMatch(/Unavailable/)
    const submit = [...screen.getByRole('dialog').querySelectorAll('button')].find(b => /^Assign 1 coach$/.test(b.textContent))
    expect(submit.disabled).toBe(false)
  })

  it("no badge when the server says the rule does not touch the shift, whatever the calendar's own rules say", async () => {
    // The calendar still holds the 10–11 rule (it shades the day with it);
    // the picker shows the server's judgement, which is the one source.
    answer = candidatesAnswer({ busyUnavailable: null })
    await openAssignPicker()
    await waitFor(() => expect(screen.queryByText('Ranking coaches…')).toBeNull())
    expect(screen.getByText('Busy Coach').closest('li').textContent).not.toMatch(/Unavailable/)
  })

  it('availability the server could not check is said in the picker, and nobody is badged', async () => {
    answer = candidatesAnswer({ busyUnavailable: null, checked: { availability: false } })
    await openAssignPicker()
    const dialog = screen.getByRole('dialog')
    expect(await screen.findByText('Could not check availability, so the order may be off.')).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/Unavailable:/)
    expect(screen.getByText('Busy Coach')).toBeTruthy()
  })

  it("the calendar's availability read failing does not blank the picker's badge", async () => {
    const base = global.fetch
    global.fetch = vi.fn(async (url) => (url.includes('/schedule/availability')
      ? { ok: false, status: 500, json: async () => ({ error: 'Could not load availability' }) }
      : base(url)))
    await openAssignPicker()
    expect(await screen.findByText('Unavailable: 10am–11am')).toBeTruthy()
  })

  it("a coach's calendar never asks for availability", async () => {
    render(<ScheduleCalendar user={coachUser} />)
    // Every read of the fan-out is started in the same Promise.allSettled, so
    // once the blocks read has gone out, any availability read would have too.
    await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => u.includes('/schedule/blocks'))).toBe(true))
    expect(global.fetch.mock.calls.some(([u]) => u.includes('/schedule/availability'))).toBe(false)
    expect(screen.queryByTestId('unavailable-bar')).toBeNull()
  })
})
