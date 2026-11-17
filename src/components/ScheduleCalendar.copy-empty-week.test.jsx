// @vitest-environment jsdom
//
// COPYEMPTY.1 — an empty week offers "Copy last week" on the week itself.
// Pure rules are in roster-card-model.test.js (emptyWeekCopyPrompt); this file
// pins the wiring: the card appears, its buttons POST the copy straight away
// (no chooser), and it stays away from coaches, staffed weeks and past weeks.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, waitFor, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'
import { addDays, formatDate, getMonday } from '@/lib/roster'

vi.setConfig({ testTimeout: 20000 })

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const COACH = { id: 'u2', role: 'coach', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }
const block = (over = {}) => ({
  id: 'b1', location_id: 'loc1', block_date: formatDate(new Date()), template_id: 't1',
  start_time: '09:00', end_time: '12:00', max_coaches: 3, min_coaches: 1,
  shift_templates: TEMPLATE, shift_assignments: [], rosters: null, ...over,
})

function mockFetch(blocks) {
  return vi.fn((url) => {
    const u = String(url)
    const body = u.includes('/api/schedule/shifts/copy-week') ? { success: true, copied: 4, skipped: 0 }
      : u.includes('/api/schedule/blocks') ? { success: true, data: blocks }
        : u.includes('contractor-spend') || u.includes('week-cost') ? { success: true, data: null }
          : { success: true, data: [] }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

async function renderCalendar({ user = MANAGER, blocks = [block()] } = {}) {
  global.fetch = mockFetch(blocks)
  await act(async () => { render(<ScheduleCalendar user={user} />) })
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
}

const copyCalls = () => global.fetch.mock.calls.filter(([u]) => String(u).includes('/api/schedule/shifts/copy-week'))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('empty-week Copy last week card (COPYEMPTY.1)', () => {
  it('shows on an empty week in place of the red gaps banner', async () => {
    await renderCalendar()
    expect(screen.getByTestId('empty-week-copy').textContent).toMatch(/No coaches on this week yet/)
    expect(screen.queryByTestId('staffing-gaps-banner')).toBeNull()
  })

  it('Copy last week posts an exact copy of last week straight away, with no chooser', async () => {
    await renderCalendar()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy last week' })) })
    await waitFor(() => expect(copyCalls()).toHaveLength(1))
    const body = JSON.parse(copyCalls()[0][1].body)
    const monday = getMonday(new Date())
    expect(body).toEqual({ location_id: 'loc1', source_start: formatDate(addDays(monday, -7)), target_start: formatDate(monday), mode: 'exact' })
    expect(screen.queryByText('Exact copy')).toBeNull()
    expect(await screen.findByText('Copied 4 shifts.')).toBeTruthy()
  })

  it('Use template times posts the template mode', async () => {
    await renderCalendar()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use template times' })) })
    await waitFor(() => expect(copyCalls()).toHaveLength(1))
    expect(JSON.parse(copyCalls()[0][1].body).mode).toBe('template')
  })

  it('is not shown once a shift this week has a coach', async () => {
    await renderCalendar({ blocks: [block({ shift_assignments: [{ id: 'a1', profile_id: 'p1', status: 'confirmed', profiles: { full_name: 'Ann' } }] })] })
    expect(screen.queryByTestId('empty-week-copy')).toBeNull()
  })

  it('is not shown to a coach', async () => {
    await renderCalendar({ user: COACH })
    expect(screen.queryByTestId('empty-week-copy')).toBeNull()
  })

  it('is not shown on a past week', async () => {
    await renderCalendar()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Previous week' })) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByTestId('empty-week-copy')).toBeNull()
  })

  it('the More menu still opens the chooser', async () => {
    await renderCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy last week' }))
    expect(await screen.findByText('Exact copy')).toBeTruthy()
  })
})
