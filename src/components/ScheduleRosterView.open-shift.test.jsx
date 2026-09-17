// @vitest-environment jsdom
//
// CAL-UI-LOW.2 — the whole path: a row in the Studio Overview day dialog
// opens THAT shift in the calendar below it.
//
// The strip and the calendar are siblings with no shared state, so the
// request travels strip → ScheduleRosterView → calendar. Testing the two
// halves separately would prove the message is sent and that something
// could receive it, and nothing about them being connected.
//
// Both cases matter and they are NOT the same code path:
//
//  - the shift is in the week already on screen. This is the COMMON one —
//    the strip only ever summarises the days the calendar is showing — and
//    it is the one an earlier cut of this feature got wrong while the
//    far-week test below stayed green.
//  - the shift is in a week the calendar is not showing. Its rows are not
//    loaded when the operator clicks, so the dialog can only open after the
//    calendar has navigated AND a load for the new range has landed.
//
// 🔴 jsdom, so: focus, navigation and which dialog is open. Nothing here
// says anything about layout (memory `jsdom-cannot-see-layout`).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleRosterView from '@/components/ScheduleRosterView'

vi.setConfig({ testTimeout: 20000 })

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function mondayOf(d) {
  const x = new Date(d)
  const day = x.getDay()
  x.setDate(x.getDate() - day + (day === 0 ? -6 : 1))
  return x
}
// Two weeks out: never the week the calendar opens on, so the click has to
// move the calendar before the shift can exist in its data.
const FAR = new Date()
FAR.setDate(FAR.getDate() + 14)
const FAR_DATE = iso(FAR)
const FAR_MONDAY = iso(mondayOf(FAR))

// Inside the week the calendar opens on: today, or the Monday of this week
// if today is in the past relative to it (it never is, but be explicit).
const NEAR_DATE = iso(new Date())

const TEMPLATE = { id: 't1', name: 'Evening', start_time: '17:00', end_time: '20:00', color: '#3B82F6', active: true, max_coaches: 3 }
const BLOCK = {
  id: 'blk-late', location_id: 'loc1', block_date: FAR_DATE, template_id: 't1',
  start_time: '17:00', end_time: '20:00', max_coaches: 3, min_coaches: 2,
  shift_templates: TEMPLATE, shift_assignments: [], rosters: null,
}
const STAFF = [{ id: 'u1', full_name: 'Colm Manager', role: 'manager', active: true, profile_locations: [{ location_id: 'loc1' }] }]
const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

const NEAR_TEMPLATE = { ...TEMPLATE, id: 't2', name: 'Morning', start_time: '06:30', end_time: '09:00' }
const NEAR_BLOCK = {
  id: 'blk-early', location_id: 'loc1', block_date: NEAR_DATE, template_id: 't2',
  start_time: '06:30', end_time: '09:00', max_coaches: 3, min_coaches: 2,
  shift_templates: NEAR_TEMPLATE, shift_assignments: [], rosters: null,
}
const NEAR_OVERVIEW_DAY = {
  date: NEAR_DATE,
  events: [], event_types: [], time_off: [],
  staff_scheduled: 0, staff_on_leave: 0, demand: 2,
  classification: 'amber',
  under_min_blocks: [{ id: NEAR_BLOCK.id, label: 'Morning', time: '06:30–09:00', assigned: 0, min: 2 }],
}

const OVERVIEW_DAY = {
  date: FAR_DATE,
  events: [], event_types: [], time_off: [],
  staff_scheduled: 0, staff_on_leave: 0, demand: 2,
  classification: 'amber',
  under_min_blocks: [{ id: BLOCK.id, label: 'Evening', time: '17:00–20:00', assigned: 0, min: 2 }],
}

// The blocks endpoint answers for the range it is ASKED for — the block only
// exists once the calendar has moved to the week holding it. That is what
// makes this a real test of the deferred open rather than of a lucky
// already-loaded row.
function mockFetch({ blocksGone = false, near = false } = {}) {
  return vi.fn((url) => {
    const u = String(url)
    let body
    if (u.includes('/api/schedule/overview')) {
      // The strip is asked for whatever range the calendar is showing; it
      // always reports the far-off flagged day, which is how an operator
      // meets a shift outside the week in front of them.
      body = { success: true, data: { days: [near ? NEAR_OVERVIEW_DAY : OVERVIEW_DAY] } }
    } else if (u.includes('/api/schedule/blocks')) {
      const start = new URL(u, 'http://x').searchParams.get('start_date')
      const end = new URL(u, 'http://x').searchParams.get('end_date')
      const target = near ? NEAR_DATE : FAR_DATE
      const row = near ? NEAR_BLOCK : BLOCK
      const inRange = start <= target && target <= end
      body = { success: true, data: inRange && !blocksGone ? [row] : [] }
    } else if (u.includes('/api/schedule/templates')) body = { success: true, data: [TEMPLATE, NEAR_TEMPLATE] }
    else if (u.includes('/api/staff')) body = { success: true, data: STAFF }
    else if (u.includes('/api/schedule/time-off')) body = { success: true, data: [] }
    else if (u.includes('/holidays')) body = { success: true, data: [] }
    else if (u.includes('contractor-spend')) body = { success: true, data: null }
    else if (u.includes('/api/schedule/week-cost')) body = { success: true, data: null }
    else if (u.includes('/api/schedule/rosters')) body = { success: true, data: [] }
    else body = { success: true, data: [] }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); replace.mockClear() })

async function renderView(opts) {
  global.fetch = mockFetch(opts)
  await act(async () => { render(<ScheduleRosterView user={MANAGER} />) })
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
  await waitFor(() => expect(screen.queryByText(/Loading overview/)).toBeNull())
}

describe('Studio Overview → the shift it names (CAL-UI-LOW.2)', () => {
  it('opens a shift that is in the week already on screen', async () => {
    // The strip summarises the days the calendar is showing, so this is what
    // an operator meets nearly every time. Nothing has to load and nothing
    // has to move: the block is already in the calendar's rows.
    await renderView({ near: true })

    fireEvent.click(screen.getByRole('button', { name: /undermanned/i }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('under-min-shift'))
    })

    await waitFor(() => {
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/Morning/)
      expect(dialog.textContent).toMatch(/6:30am\s*–\s*9am/)
    })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('navigates the calendar to the date and opens that shift', async () => {
    await renderView()

    // Open the day summary from the overview strip.
    fireEvent.click(screen.getByRole('button', { name: /undermanned/i }))
    const summary = screen.getByRole('dialog')
    expect(summary.textContent).toMatch(/0 of 2 assigned/)

    await act(async () => {
      fireEvent.click(screen.getByTestId('under-min-shift'))
    })

    // The calendar moved to the week holding that date…
    await waitFor(() => {
      expect(replace.mock.calls.some(([href]) => String(href).includes(`week=${FAR_MONDAY}`))).toBe(true)
    })

    // …and the block-detail dialog for that shift is what is open now — the
    // same surface a click on the block card opens.
    await waitFor(() => {
      const dialog = screen.getByRole('dialog')
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
      expect(dialog.textContent).toMatch(/Evening/)
      expect(dialog.textContent).toMatch(/5pm\s*–\s*8pm/)
    })
    // The day summary is gone rather than stacked behind it.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('says so instead of doing nothing when the shift has gone', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('button', { name: /undermanned/i }))

    // The roster no longer has the block the overview named — deleted between
    // the strip's fetch and the click. Silence here is the defect class this
    // repo keeps paying for, so the operator is told.
    global.fetch = mockFetch({ blocksGone: true })

    await act(async () => {
      fireEvent.click(screen.getByTestId('under-min-shift'))
    })

    await waitFor(() => {
      expect(screen.getByText(/no longer on the roster/i)).toBeTruthy()
    })
  })
})
