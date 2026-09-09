// @vitest-environment jsdom
//
// ROSTER-FIX.6c — the assign picker's clash / leave advisory reaches the DOM.
//
// The rules themselves are pinned in src/lib/schedule-overlap.test.js; this
// file exists for the half a pure test cannot reach — that the calendar hands
// the modal the blocks and the leave it already holds, and that the badge is
// advisory, so the row it is attached to is still tickable.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const LOC = 'loc1'
const user = { id: 'u1', role: 'manager', activeLocation: { id: LOC, name: 'Stillorgan' } }

// Wednesday of the week the URL params pin.
const DATE = '2026-05-06'

const targetBlock = {
  id: 'b-target',
  location_id: LOC,
  template_id: 't2',
  block_date: DATE,
  start_time: '10:00:00',
  end_time: '12:00:00',
  max_coaches: 3,
  shift_templates: { id: 't2', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [],
}

const busyBlock = {
  id: 'b-other',
  location_id: LOC,
  template_id: 't1',
  block_date: DATE,
  start_time: '09:30:00',
  end_time: '11:00:00',
  max_coaches: 3,
  shift_templates: { id: 't1', name: 'Morning HIIT', start_time: '09:30:00', end_time: '11:00:00' },
  shift_assignments: [{ id: 'a1', profile_id: 'c-clash', status: 'scheduled', profiles: { full_name: 'Clash Coach' } }],
}

const staff = [
  { id: 'c-clash', full_name: 'Clash Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-leave', full_name: 'Leave Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-free', full_name: 'Free Coach', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]

const timeOff = [
  { id: 'to1', profile_id: 'c-leave', status: 'approved', type: 'holiday', start_date: '2026-05-05', end_date: '2026-05-07', profiles: { full_name: 'Leave Coach' } },
]

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

beforeEach(() => {
  global.fetch = vi.fn(async (url) => {
    if (url.includes('/schedule/blocks')) return okResponse({ success: true, data: [targetBlock, busyBlock] })
    if (url.includes('/schedule/time-off')) return okResponse({ success: true, data: timeOff })
    if (url.includes('/api/staff')) return okResponse({ success: true, data: staff })
    return okResponse({ success: true, data: [] })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function openAssignPicker() {
  render(<ScheduleCalendar user={user} />)
  await waitFor(() => expect(screen.getByText('Midday Strength')).toBeTruthy())
  fireEvent.click(screen.getByText('Midday Strength'))
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
  fireEvent.click(screen.getByText('Add coach'))
  // 'Assign coaches' is both the dialog heading and the idle submit label, so
  // wait on something only the open picker renders.
  await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
}

describe('assign picker conflict badges (ROSTER-FIX.6c)', () => {
  it('badges the coach who already has an overlapping shift that day', async () => {
    await openAssignPicker()
    expect(screen.getByText('clashes with 09:30 Morning HIIT')).toBeTruthy()
  })

  it('badges the coach on approved leave for that date', async () => {
    await openAssignPicker()
    expect(screen.getByText('on approved leave')).toBeTruthy()
  })

  it('says nothing about a coach who is free', async () => {
    await openAssignPicker()
    const row = screen.getByText('Free Coach').closest('li')
    expect(row.textContent).not.toMatch(/clashes|leave/)
  })

  it('is advisory: a flagged coach can still be ticked', async () => {
    await openAssignPicker()
    const badge = screen.getByText('clashes with 09:30 Morning HIIT')
    const checkbox = badge.closest('label').querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Assign 1 coach')).toBeTruthy()
  })
})
