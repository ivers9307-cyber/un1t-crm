// @vitest-environment jsdom
//
// ROSTERLOAD.1 — the operator-visible half of the per-slice load. When one of
// the side reads fails (leave, bank holidays, coach list, templates, spend)
// the roster still renders, and the missing slice is SAID rather than left
// silently empty: an empty leave slice reads as "nobody is on leave", and a
// manager rosters over approved leave on the strength of it. The actions that
// depend on a missing list are disabled with the reason, never offered with an
// empty picker. No fake timers anywhere in this file.

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
import {
  partialLoadLines,
  STAFF_UNAVAILABLE_MESSAGE,
  TEMPLATES_UNAVAILABLE_MESSAGE,
  LEAVE_NOT_FLAGGED_MESSAGE,
} from './schedule/SchedulePartialLoadNote'
import { SESSION_ENDED_MESSAGE } from './schedule/useScheduleData'

const LOC = 'loc1'
const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC, name: 'Stillorgan' } }

const block = {
  id: 'b1',
  location_id: LOC,
  template_id: 't1',
  block_date: '2026-05-06',
  start_time: '10:00:00',
  end_time: '12:00:00',
  max_coaches: 3,
  shift_templates: { id: 't1', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [],
}
const staff = [
  { id: 'c1', full_name: 'Free Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]
const templates = [{ id: 't1', name: 'Midday Strength', active: true, start_time: '10:00:00', end_time: '12:00:00' }]

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}
const broken = { ok: false, status: 500, json: async () => ({ error: 'Database is unavailable' }) }

// Answers every read normally except those whose URL contains one of `fail`.
function fetchFailing(fail = [], response = broken) {
  return vi.fn(async (url) => {
    if (fail.some(f => url.includes(f))) return response
    if (url.includes('/schedule/blocks')) return okResponse({ success: true, data: [block] })
    if (url.includes('/api/staff')) return okResponse({ success: true, data: staff })
    if (url.includes('/schedule/templates')) return okResponse({ success: true, data: templates })
    if (url.includes('contractor-spend')) return okResponse({ success: true, data: {} })
    return okResponse({ success: true, data: [] })
  })
}

const LEAVE_LINE = 'Leave could not be loaded. Days off are not shown, so check leave before assigning coaches.'

beforeEach(() => { global.fetch = fetchFailing() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function rosterOnScreen() {
  await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ })
}

describe('a side read failing does not fail the roster (ROSTERLOAD.1)', () => {
  it('leave failing: the roster renders and the note says leave is missing', async () => {
    global.fetch = fetchFailing(['/schedule/time-off'])
    render(<ScheduleCalendar user={manager} />)
    await rosterOnScreen()
    await waitFor(() => expect(screen.getByText(LEAVE_LINE)).toBeTruthy())
    expect(screen.queryByText('Could not load the roster')).toBeNull()
  })

  it('Retry on the note re-runs the load, and a clean load removes the note', async () => {
    global.fetch = fetchFailing(['/schedule/time-off'])
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.getByText(LEAVE_LINE)).toBeTruthy())

    global.fetch = fetchFailing()
    const note = screen.getByTestId('schedule-partial-load-note')
    fireEvent.click(note.querySelector('button'))
    await waitFor(() => expect(screen.queryByText(LEAVE_LINE)).toBeNull())
    expect(global.fetch.mock.calls.some(([url]) => url.includes('/schedule/time-off'))).toBe(true)
  })

  it('bank holidays failing are named too', async () => {
    global.fetch = fetchFailing(['/holidays'])
    render(<ScheduleCalendar user={manager} />)
    await rosterOnScreen()
    await waitFor(() => expect(screen.getByText('Bank holidays and closures could not be loaded, so they are not marked on the calendar.')).toBeTruthy())
  })

  it('a healthy load shows no note', async () => {
    render(<ScheduleCalendar user={manager} />)
    await rosterOnScreen()
    expect(screen.queryByTestId('schedule-partial-load-note')).toBeNull()
  })

  it('a signed-out answer on a side read is the roster banner, not a quiet note', async () => {
    global.fetch = fetchFailing(['/holidays'], { ok: false, status: 401, json: async () => ({}) })
    render(<ScheduleCalendar user={manager} />)
    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
    expect(screen.getByText(SESSION_ENDED_MESSAGE)).toBeTruthy()
    expect(screen.queryByTestId('schedule-partial-load-note')).toBeNull()
  })
})

describe('actions that depend on a missing list are disabled with the reason', () => {
  async function openAssignPicker() {
    render(<ScheduleCalendar user={manager} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }))
    await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
    fireEvent.click(screen.getByText('Add coach'))
    await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
  }

  it('coach list missing: the picker says why and cannot submit, instead of an empty list', async () => {
    global.fetch = fetchFailing(['/api/staff'])
    await openAssignPicker()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(STAFF_UNAVAILABLE_MESSAGE)
    expect(dialog.textContent).not.toContain('All staff already assigned to this slot.')
    const submit = [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Assign coaches')
    expect(submit.disabled).toBe(true)
  })

  it('leave missing: the picker says leave is not flagged, and coaches stay pickable', async () => {
    global.fetch = fetchFailing(['/schedule/time-off'])
    await openAssignPicker()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(LEAVE_NOT_FLAGGED_MESSAGE)
    expect(screen.getByText('Free Coach')).toBeTruthy()
  })

  it('templates missing: Add Slot says why and cannot submit', async () => {
    global.fetch = fetchFailing(['/schedule/templates'])
    render(<ScheduleCalendar user={manager} />)
    await rosterOnScreen()
    fireEvent.click(screen.getAllByText('Add Slot')[0])
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(TEMPLATES_UNAVAILABLE_MESSAGE)
    expect(dialog.querySelector('select').disabled).toBe(true)
  })
})

describe('partialLoadLines', () => {
  const all = {
    timeOff: { message: 'x', kept: false },
    holidays: { message: 'x', kept: true },
    staff: { message: 'x', kept: false },
    templates: { message: 'x', kept: true },
    contractorSpend: { message: 'x', kept: false },
  }

  it('says "could not be refreshed" for a kept slice and "could not be loaded" for a cleared one', () => {
    const lines = partialLoadLines(all, { isManager: true })
    expect(lines).toEqual([
      LEAVE_LINE,
      'Bank holidays and closures could not be refreshed. Showing them as they last loaded.',
      STAFF_UNAVAILABLE_MESSAGE,
      'Shift templates could not be refreshed. Showing the list that loaded earlier.',
      'Contractor spend could not be loaded.',
    ])
    for (const l of lines) expect(l).not.toMatch(/—/)
  })

  it('a coach is told only about what they can see: leave and holidays', () => {
    expect(partialLoadLines(all, { isManager: false })).toHaveLength(2)
  })

  it('nothing to say when nothing failed', () => {
    expect(partialLoadLines(null, { isManager: true })).toEqual([])
  })
})
