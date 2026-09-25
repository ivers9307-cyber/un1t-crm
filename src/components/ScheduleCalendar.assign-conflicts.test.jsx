// @vitest-environment jsdom
//
// ROSTER-FIX.6c — the assign picker's clash / leave advisory reaches the DOM.
//
// CANDIDATES.1 moved the SOURCE: the badges come from the server's ranked
// answer (GET /api/schedule/blocks/[id]/candidates), which judges effective
// windows at every studio of the organisation, not from the blocks and leave
// the calendar happens to hold. The rules are pinned in
// shared/candidates.test.js; this file keeps the half a pure test cannot
// reach — that the picker shows what the answer says, and that the badge is
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

// What the server says about the fixture above: Clash Coach is on Morning HIIT
// 9:30–11 (this studio, so no studio is named), Leave Coach is on holiday.
const free = { free: true, busy: null, on_leave: null, unavailable: null, on_site: null, rest_gap: null, week_over: null, contracted_hours: null, week_minutes: 0 }
const CANDIDATES = {
  success: true,
  data: {
    audience: 'manager', block_id: 'b-target', untimed: 0,
    checked: { shifts: true, cross_studio: true, leave: true, availability: true, contract: true },
    candidates: [
      { ...free, profile_id: 'c-free', full_name: 'Free Coach', role: 'staff', rank: 1, tier: 'ready' },
      { ...free, profile_id: 'c-clash', full_name: 'Clash Coach', role: 'staff', rank: 2, tier: 'blocked', free: false, week_minutes: 90,
        busy: { block_id: 'b-other', date: DATE, start: '09:30', end: '11:00', name: 'Morning HIIT', location_name: null } },
      { ...free, profile_id: 'c-leave', full_name: 'Leave Coach', role: 'staff', rank: 3, tier: 'blocked',
        on_leave: { type: 'holiday', label: 'Holiday', start_date: '2026-05-05', end_date: '2026-05-07' } },
    ],
  },
}

beforeEach(() => {
  global.fetch = vi.fn(async (url) => {
    // Before '/schedule/blocks': the candidates URL contains it too.
    if (url.includes('/candidates')) return okResponse(CANDIDATES)
    if (url.includes('/schedule/blocks')) return okResponse({ success: true, data: [targetBlock, busyBlock] })
    if (url.includes('/schedule/time-off')) return okResponse({ success: true, data: timeOff })
    if (url.includes('/api/staff')) return okResponse({ success: true, data: staff })
    return okResponse({ success: true, data: [] })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function openAssignPicker() {
  render(<ScheduleCalendar user={user} />)
  // ROSTER-FIX.6b landed first: the week card is a plain container now and the
  // click target is a real <button> stretched over it, named from the block
  // ("Manage 10am Midday Strength shift, Wednesday 6 May"). Clicking the
  // template name inside the card no longer opens anything, so drive the
  // button the operator actually reaches.
  const openCard = await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ })
  fireEvent.click(openCard)
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
  fireEvent.click(screen.getByText('Add coach'))
  // 'Assign coaches' is both the dialog heading and the idle submit label, so
  // wait on something only the open picker renders.
  await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
}

describe('assign picker conflict badges (ROSTER-FIX.6c)', () => {
  it('badges the coach who already has an overlapping shift that day', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('clashes with 9:30am Morning HIIT')
    expect(badge.closest('li').textContent).toMatch(/Clash Coach/)
    expect(badge.getAttribute('title')).toBe('Already on Morning HIIT, 9:30am–11am')
  })

  it('badges the coach on approved leave for that date', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('on approved leave')
    expect(badge.closest('li').textContent).toMatch(/Leave Coach/)
    expect(badge.getAttribute('title')).toBe('Holiday, Tue 5 May to Thu 7 May')
  })

  it('says nothing about a coach who is free', async () => {
    await openAssignPicker()
    await screen.findByText('on approved leave')
    const row = screen.getByText('Free Coach').closest('li')
    expect(row.textContent).not.toMatch(/clashes|leave/)
  })

  it('is advisory: a flagged coach can still be ticked', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('clashes with 9:30am Morning HIIT')
    const checkbox = badge.closest('label').querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Assign 1 coach')).toBeTruthy()
  })
})
