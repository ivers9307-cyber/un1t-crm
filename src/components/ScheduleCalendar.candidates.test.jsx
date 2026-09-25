// @vitest-environment jsdom
//
// CANDIDATES.1 — the web assign picker lists the server's RANKED candidates
// (GET /api/schedule/blocks/[id]/candidates), with the badges and an hours
// line, and stays advisory: every row can be ticked. The server's answer is
// the ONE source of the picker's warnings (clash, leave, availability, rest,
// week): until it lands, or if it fails or is not understood, the picker is
// this studio's staff A–Z with NO warnings and a note saying so. The rules
// are pinned in shared/candidates.test.js; this is the wiring. jsdom has no
// layout: text, roles and presence only. No fake timers.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

// See ScheduleCalendar.errors.test.jsx: the budget exceeds the waits below.
vi.setConfig({ testTimeout: 20000 })

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'
import { CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE } from '@shared/candidates'

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

const coach = (id, full_name) => ({ id, full_name, role: 'staff', active: true, profile_locations: [{ location_id: LOC }] })
const staff = [
  coach('c-unav', 'Away Coach'), coach('c-busy', 'Busy Coach'), coach('c-here', 'Here Coach'),
  coach('c-leave', 'Leave Coach'), coach('c-rest', 'Rest Coach'), coach('c-week', 'Week Coach'),
]

const none = { free: true, busy: null, on_leave: null, unavailable: null, on_site: null, rest_gap: null, week_over: null, contracted_hours: null }
const ANSWER = {
  success: true,
  data: {
    audience: 'manager', block_id: 'b-target', untimed: 0,
    checked: { shifts: true, cross_studio: true, leave: true, availability: true, contract: true },
    candidates: [
      { ...none, profile_id: 'c-here', full_name: 'Here Coach', role: 'staff', rank: 1, tier: 'ready', on_site: { block_id: 'x1', start: '07:00', end: '09:00', name: 'Early', gap_minutes: 60 }, week_minutes: 120 },
      { ...none, profile_id: 'c-rest', full_name: 'Rest Coach', role: 'staff', rank: 2, tier: 'advisory', week_minutes: 90, contracted_hours: 39,
        rest_gap: { rest_minutes: 570, side: 'before', other: { block_id: 'x', date: '2026-05-05', start: '20:00', end: '21:30', name: 'Evening', location_name: 'Studio South' } } },
      { ...none, profile_id: 'c-week', full_name: 'Week Coach', role: 'staff', rank: 3, tier: 'advisory', week_minutes: 2790, contracted_hours: 39,
        week_over: { week_start: '2026-05-04', minutes: 2910 } },
      { ...none, profile_id: 'c-unav', full_name: 'Away Coach', role: 'staff', rank: 4, tier: 'unavailable', week_minutes: 0, contracted_hours: 30,
        unavailable: { summary: '10am–11am', detail: 'Wednesdays, 10am–11am (School run)' } },
      { ...none, profile_id: 'c-busy', full_name: 'Busy Coach', role: 'staff', rank: 5, tier: 'blocked', free: false, week_minutes: 60,
        busy: { block_id: 'b-busy', date: '2026-05-06', start: '09:30', end: '10:30', name: 'Morning HIIT', location_name: null } },
      { ...none, profile_id: 'c-leave', full_name: 'Leave Coach', role: 'staff', rank: 6, tier: 'blocked', week_minutes: 0,
        on_leave: { label: 'Holiday', start_date: '2026-05-05', end_date: '2026-05-07' } },
    ],
  },
}

function okResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

function mockFetch({ answer = ANSWER, status = 200 } = {}) {
  return vi.fn(async (url) => {
    const u = String(url)
    // Before '/schedule/blocks': the candidates URL contains it too.
    if (u.includes('/candidates')) return okResponse(answer, status)
    if (u.includes('/schedule/blocks')) return okResponse({ success: true, data: [targetBlock] })
    if (u.includes('/api/staff')) return okResponse({ success: true, data: staff })
    return okResponse({ success: true, data: [] })
  })
}

async function openAssignPicker() {
  render(<ScheduleCalendar user={user} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }))
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy())
  fireEvent.click(screen.getByText('Add coach'))
  await waitFor(() => expect(screen.getByText('Pick one or more coaches')).toBeTruthy())
}

const items = () => within(screen.getByRole('dialog')).getAllByRole('listitem')
const rowNames = () => items().map((li) => li.querySelector('.flex-1').firstChild.textContent)

beforeEach(() => { global.fetch = mockFetch() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('assign picker: ranked candidates (CANDIDATES.1)', () => {
  it("lists coaches in the server's order, each with its hours line, and no pay", async () => {
    await openAssignPicker()
    await waitFor(() => expect(rowNames()[0]).toBe('Here Coach'))
    expect(rowNames()).toEqual(['Here Coach', 'Rest Coach', 'Week Coach', 'Away Coach', 'Busy Coach', 'Leave Coach'])
    expect(items()[0].textContent).toContain('Here 7am–9am · 2h this week')
    expect(items()[1].textContent).toContain('1h 30m of 39h this week')
    expect(items()[3].textContent).toContain('0h of 30h this week')
    expect(items()[5].textContent).toContain('No shifts this week')
    expect(screen.getByRole('dialog').textContent).not.toMatch(/€|salary|hourly/i)
  })

  it('badges leave, a clash, unavailability, short rest and a long week, with titles', async () => {
    await openAssignPicker()
    const rest = await screen.findByText('9h 30m rest')
    expect(rest.closest('li').textContent).toMatch(/Rest Coach/)
    expect(rest.getAttribute('title')).toMatch(/Evening 8pm–9:30pm at Studio South on Tue 5 May/)
    expect(rest.getAttribute('title')).toMatch(/11 hours between working days/)
    expect(screen.getByText('48h 30m this week').getAttribute('title')).toMatch(/over the 48-hour limit/)
    expect(screen.getByText('Unavailable: 10am–11am').getAttribute('title')).toBe('Wednesdays, 10am–11am (School run)')
    const clash = screen.getByText('clashes with 9:30am Morning HIIT')
    expect(clash.closest('li').textContent).toMatch(/Busy Coach/)
    expect(clash.getAttribute('title')).toBe('Already on Morning HIIT, 9:30am–10:30am')
    expect(screen.getByText('on approved leave').getAttribute('title')).toBe('Holiday, Tue 5 May to Thu 7 May')
  })

  it('asks once, for this block, and no longer asks the working-time route', async () => {
    await openAssignPicker()
    await screen.findByText('9h 30m rest')
    const urls = global.fetch.mock.calls.map(([u]) => String(u))
    expect(urls.filter((u) => u.includes('/candidates'))).toEqual(['/api/schedule/blocks/b-target/candidates'])
    expect(urls.some((u) => u.includes('/api/schedule/working-time'))).toBe(false)
  })

  it('is advisory: the coach at the bottom can still be ticked', async () => {
    await openAssignPicker()
    const badge = await screen.findByText('on approved leave')
    const checkbox = badge.closest('label').querySelector('input[type="checkbox"]')
    expect(checkbox.disabled).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText('Assign 1 coach')).toBeTruthy()
  })

  it('says what it could not check, and how many shifts had no times', async () => {
    global.fetch = mockFetch({ answer: { ...ANSWER, data: { ...ANSWER.data, checked: { ...ANSWER.data.checked, leave: false }, untimed: 1 } } })
    await openAssignPicker()
    expect(await screen.findByText('Could not check leave, so the order may be off.')).toBeTruthy()
    expect(screen.getByText('1 shift without times was not counted.')).toBeTruthy()
  })
})

// CANDIDATES.1 review 2 — the other studios unread: free means free HERE.
describe('assign picker: the other studios could not be checked', () => {
  it('says so, and a free row reads "Free here", never a bare all-clear', async () => {
    global.fetch = mockFetch({ answer: { ...ANSWER, data: { ...ANSWER.data, checked: { ...ANSWER.data.checked, cross_studio: false } } } })
    await openAssignPicker()
    expect(await screen.findByText('Could not check the other studios, so the order may be off.')).toBeTruthy()
    const rest = items()[1]
    expect(rest.textContent).toContain('Rest Coach')
    expect(rest.textContent).toContain('Free here · 1h 30m of 39h this week')
    // On site, on leave or unavailable rows lead with that instead.
    expect(items()[0].textContent).not.toContain('Free here')
    expect(items()[3].textContent).not.toContain('Free here')
  })

  it('checked: no "Free here" anywhere', async () => {
    await openAssignPicker()
    await screen.findByText('9h 30m rest')
    expect(screen.getByRole('dialog').textContent).not.toContain('Free here')
  })
})

describe('assign picker: before, or without, a ranked answer (CANDIDATES.1)', () => {
  it('shows the studio A–Z while ranking, then the ranked order', async () => {
    let answer
    const base = mockFetch()
    global.fetch = vi.fn((url, opts) => (String(url).includes('/candidates')
      ? new Promise((resolve) => { answer = resolve })
      : base(url, opts)))
    await openAssignPicker()
    expect(await screen.findByText(CANDIDATES_RANKING_NOTE)).toBeTruthy()
    expect(rowNames()).toEqual(['Away Coach', 'Busy Coach', 'Here Coach', 'Leave Coach', 'Rest Coach', 'Week Coach'])
    answer(okResponse(ANSWER))
    await waitFor(() => expect(rowNames()[0]).toBe('Here Coach'))
    expect(screen.queryByText(CANDIDATES_RANKING_NOTE)).toBeNull()
  })

  it('a failed ask says so and keeps the A–Z list, with no warning of any kind', async () => {
    global.fetch = mockFetch({ answer: { success: false, error: 'boom' }, status: 500 })
    await openAssignPicker()
    expect(await screen.findByText(CANDIDATES_UNRANKED_NOTE)).toBeTruthy()
    expect(rowNames()).toEqual(['Away Coach', 'Busy Coach', 'Here Coach', 'Leave Coach', 'Rest Coach', 'Week Coach'])
    expect(screen.getByRole('dialog').textContent).not.toMatch(/rest|this week|clashes|approved leave|Unavailable/)
    // Still advisory: the list can be used.
    const box = items()[0].querySelector('input[type="checkbox"]')
    fireEvent.click(box)
    expect(box.checked).toBe(true)
  })

  it('an answer it does not recognise (an older server) is treated as unranked, and says so', async () => {
    global.fetch = mockFetch({ answer: { success: true, data: [] } })
    await openAssignPicker()
    expect(await screen.findByText(CANDIDATES_UNRANKED_NOTE)).toBeTruthy()
    expect(screen.queryByText(CANDIDATES_RANKING_NOTE)).toBeNull()
    expect(rowNames()[0]).toBe('Away Coach')
  })

  it("the calendar's own leave, clash and availability data no longer badge the picker: the server's answer is the one source", async () => {
    // The calendar holds a clash for Busy Coach, leave for Leave Coach and a
    // rule for Away Coach; the server (which judges the effective window, at
    // every studio) says all three are free. The picker shows the server.
    const clashing = {
      ...targetBlock, id: 'b-busy', start_time: '09:30:00', end_time: '10:30:00',
      shift_templates: { id: 't1', name: 'Morning HIIT', start_time: '09:30:00', end_time: '10:30:00' },
      shift_assignments: [{ id: 'a1', profile_id: 'c-busy', status: 'scheduled', profiles: { full_name: 'Busy Coach' } }],
    }
    const leave = [{ id: 'to1', profile_id: 'c-leave', status: 'approved', type: 'holiday', start_date: '2026-05-05', end_date: '2026-05-07', profiles: { full_name: 'Leave Coach' } }]
    const rules = [{ id: 'av1', profile_id: 'c-unav', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null }]
    const allFree = { ...ANSWER, data: { ...ANSWER.data, candidates: staff.map((s, i) => ({ ...none, profile_id: s.id, full_name: s.full_name, role: 'staff', rank: i + 1, tier: 'ready', week_minutes: 0 })) } }
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/candidates')) return okResponse(allFree)
      if (u.includes('/schedule/blocks')) return okResponse({ success: true, data: [targetBlock, clashing] })
      if (u.includes('/schedule/time-off')) return okResponse({ success: true, data: leave })
      if (u.includes('/schedule/availability')) return okResponse({ success: true, data: rules })
      if (u.includes('/api/staff')) return okResponse({ success: true, data: staff })
      return okResponse({ success: true, data: [] })
    })
    await openAssignPicker()
    await waitFor(() => expect(screen.queryByText(CANDIDATES_RANKING_NOTE)).toBeNull())
    expect(screen.getByRole('dialog').textContent).not.toMatch(/clashes|approved leave|Unavailable/)
  })
})
