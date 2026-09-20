// @vitest-environment jsdom
//
// ROSTERLOOK.1 (was CAL-UI-LOW.1) — the roster's chrome is ONE toolbar row.
//
// 🔴 THIS FILE IS NOT PROOF OF LAYOUT. jsdom has no layout engine (memory
// `jsdom-cannot-see-layout`): it cannot tell one row from two, or a wrapped
// row from one overflowing off a phone. It pins the WIRING: what is on the
// row, what is in More, what each control is called, that every action still
// reaches its handler, and that the week-view-only rule survived. The row
// itself is pinned in schedule/RosterToolbar.test.jsx; the layout was checked
// in a browser at 1280 and 390.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const COACH = { id: 'u2', role: 'coach', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }
// One unpublished block today, so the publication chip has something to say.
const BLOCK = {
  id: 'b1', location_id: 'loc1', block_date: iso(new Date()), template_id: 't1',
  start_time: '09:00', end_time: '12:00', max_coaches: 3, min_coaches: 1,
  shift_templates: TEMPLATE, shift_assignments: [], rosters: null,
}

function mockFetch() {
  return vi.fn((url) => {
    const u = String(url)
    const body = u.includes('/api/schedule/blocks') ? { success: true, data: [BLOCK] }
      : u.includes('contractor-spend') || u.includes('week-cost') ? { success: true, data: null }
        : { success: true, data: [] }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

async function renderCalendar(user = MANAGER) {
  global.fetch = mockFetch()
  await act(async () => { render(<ScheduleCalendar user={user} />) })
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('roster toolbar wiring (ROSTERLOOK.1)', () => {
  it('there is one toolbar, and no second navigation row under it', async () => {
    await renderCalendar()
    expect(screen.getAllByTestId('schedule-toolbar')).toHaveLength(1)
    const nav = screen.getByTestId('schedule-toolbar-nav')
    // The arrows, Today and the chip all live in the toolbar's left group now.
    expect(within(nav).getByRole('button', { name: 'Previous week' })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Next week' })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Today' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Previous week' })).toHaveLength(1)
  })

  it('the publish-state chip keeps its test id and its words, inside the left group', async () => {
    await renderCalendar()
    const chip = screen.getByTestId('publication-status')
    expect(screen.getByTestId('schedule-toolbar-nav').contains(chip)).toBe(true)
    expect(chip.textContent).toMatch(/Week status: Not published/)
    // Still a live region, and it may not break mid-label inside the row.
    expect(chip.closest('[role="status"]')).toBeTruthy()
    // The SLOT carries nowrap, so it holds whatever element the chip is
    // (CHANGELOG.1: a button when published, a span otherwise).
    expect(chip.closest('[role="status"]').parentElement.className).toMatch(/whitespace-nowrap/)
  })

  // CAL-UI-LOW.1's pins, carried over: the row wraps, Publish is IN the
  // wrapping row, and no label may break mid-word.
  it('keeps the wrapping classes, and Publish inside the wrapping row', async () => {
    await renderCalendar()
    const toolbar = screen.getByTestId('schedule-toolbar')
    expect(toolbar.className).toMatch(/\bflex-wrap\b/)
    const publish = screen.getByRole('button', { name: /^Publish$/ })
    expect(toolbar.contains(publish)).toBe(true)
    expect(publish.className).toMatch(/whitespace-nowrap/)
  })

  it('drops the visible "Schedule / studio — Staff roster" block but keeps a heading for the roster', async () => {
    await renderCalendar()
    expect(screen.queryByText(/— Staff roster/)).toBeNull()
    const heading = screen.getByRole('heading', { level: 2, name: 'Stillorgan staff roster' })
    expect(heading.className).toMatch(/\bsr-only\b/)
  })

  it('Publish is on the row in week view only; More keeps all five actions in month view', async () => {
    await renderCalendar()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')).toHaveLength(5)
  })

  it('Copy last week, reached through More, still opens the copy chooser', async () => {
    await renderCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy last week' }))
    expect(await screen.findByText('Exact copy')).toBeTruthy()
  })

  it('Select multiple, reached through More, turns select mode on and marks the menu button', async () => {
    await renderCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Select multiple' }))
    expect(screen.getByText('Click shifts on the calendar to select')).toBeTruthy()
    // The mode is in the button's WORDS, not only its amber fill.
    const more = screen.getByRole('button', { name: 'More · selecting' })
    expect(more.getAttribute('data-active')).toBe('true')
    fireEvent.click(more)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Exit multi-select (0)' }).getAttribute('aria-checked')).toBe('true')
  })

  it('a coach gets Time off as a link, and no More, Publish or chip', async () => {
    await renderCalendar(COACH)
    expect(screen.getByRole('link', { name: 'Time off' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    expect(screen.queryByTestId('publication-status')).toBeNull()
  })

  // 🔴 The coach boundary, on the real calendar: the manager actions are not
  // tucked away somewhere a coach could open, they are not rendered.
  it('a coach cannot reach any manager action from the toolbar', async () => {
    await renderCalendar(COACH)
    const toolbar = screen.getByTestId('schedule-toolbar')
    expect(toolbar.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(toolbar.textContent).not.toMatch(/Select multiple|Copy last week|Copy last month|Manage templates|Publish/i)
    expect(document.querySelector('a[href="/settings/shifts"]')).toBeNull()
  })
})
