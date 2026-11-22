// @vitest-environment jsdom
//
// USUALCOACH.1 — the empty-week card's "Fill usual coaches": shown only when a
// template has usual coaches, posts this week straight away, says the outcome.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, waitFor, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'
import { formatDate, getMonday } from '@/lib/roster'

vi.setConfig({ testTimeout: 20000 })

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }
const block = () => ({
  id: 'b1', location_id: 'loc1', block_date: formatDate(new Date()), template_id: 't1',
  start_time: '09:00', end_time: '12:00', max_coaches: 3, min_coaches: 1,
  shift_templates: TEMPLATE, shift_assignments: [], rosters: null,
})

function mockFetch(templates) {
  return vi.fn((url) => {
    const u = String(url)
    const body = u.includes('/api/schedule/shifts/fill-usual') ? { success: true, assigned: 3, skipped: 1, counts: { time_off: 1 } }
      : u.includes('/api/schedule/templates') ? { success: true, data: templates }
        : u.includes('/api/schedule/blocks') ? { success: true, data: [block()] }
          : u.includes('contractor-spend') || u.includes('week-cost') ? { success: true, data: null }
            : { success: true, data: [] }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

async function renderCalendar(templates) {
  global.fetch = mockFetch(templates)
  await act(async () => { render(<ScheduleCalendar user={MANAGER} />) })
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
}

const fillCalls = () => global.fetch.mock.calls.filter(([u]) => String(u).includes('/api/schedule/shifts/fill-usual'))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Fill usual coaches on the empty week (USUALCOACH.1)', () => {
  it('is offered only when a template has usual coaches', async () => {
    await renderCalendar([{ ...TEMPLATE, usual_coach_ids: [] }])
    expect(screen.getByTestId('empty-week-copy')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Fill usual coaches' })).toBeNull()
  })

  it('posts this week and says what was added and skipped', async () => {
    await renderCalendar([{ ...TEMPLATE, usual_coach_ids: ['p1'] }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fill usual coaches' })) })
    await waitFor(() => expect(fillCalls()).toHaveLength(1))
    expect(JSON.parse(fillCalls()[0][1].body)).toEqual({ location_id: 'loc1', week_start: formatDate(getMonday(new Date())) })
    expect(await screen.findByText('Added 3 usual coaches. Skipped: 1 coach on approved leave.')).toBeTruthy()
  })
})
