// @vitest-environment jsdom
// BLOCKEDIT.1 — the shift dialog: everyone reads the briefing; a manager
// edits the shift. Semantics only (memory `jsdom-cannot-see-layout`).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'

vi.setConfig({ testTimeout: 20000 })

function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const today = iso(new Date())
const monday = (() => { const d = new Date(); const day = d.getDay(); d.setDate(d.getDate() - day + (day === 0 ? -6 : 1)); return iso(d) })()
const BLOCK_DATE = monday > today ? monday : today

const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }
const BLOCK = {
  id: 'b1', location_id: 'loc1', block_date: BLOCK_DATE, template_id: 't1',
  start_time: '09:00', end_time: '12:00', min_coaches: 1, max_coaches: 3,
  briefing: 'Fire drill at 10', rosters: { status: 'published' },
  shift_templates: TEMPLATE,
  shift_assignments: [{ id: 'a1', profile_id: 'u2', status: 'confirmed', start_time_override: null, end_time_override: null, profiles: { full_name: 'Sam Demo' } }],
}
const STAFF = [
  { id: 'u1', full_name: 'Casey Manager', role: 'manager', active: true, profile_locations: [{ location_id: 'loc1' }] },
  { id: 'u2', full_name: 'Sam Demo', role: 'coach', active: true, profile_locations: [{ location_id: 'loc1' }] },
]
const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const COACH = { id: 'u2', role: 'coach', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

function mockFetch() {
  return vi.fn((url, init) => {
    const body = init?.method === 'PUT'
      ? { success: true, data: { id: 'b1' }, notice: { coaches: 1, when: 'shortly' } }
      : url.includes('/api/schedule/blocks') ? { success: true, data: [BLOCK] }
        : url.includes('/api/schedule/templates') ? { success: true, data: [TEMPLATE] }
          : url.includes('/api/staff') ? { success: true, data: STAFF }
            : url.includes('/api/schedule/time-off') ? { success: true, data: [] }
              : url.includes('/holidays') ? { success: true, data: [] }
                : url.includes('contractor-spend') ? { success: true, data: null }
                  // The a11y suite's default (the publish dry run); copy any branch it gained since.
                  : { success: true, impact: { blockCount: 1, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: 0, overBudget: false } }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  })
}

async function openShift(user) {
  global.fetch = mockFetch()
  await act(async () => { render(<ScheduleCalendar user={user} />) })
  fireEvent.click(screen.getByRole('button', { name: /^Manage .*Morning shift,/ }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('shift dialog — briefing and edit (BLOCKEDIT.1)', () => {
  it('a coach reads the briefing and gets no edit control', async () => {
    await openShift(COACH)
    expect(screen.getByTestId('block-briefing').textContent).toMatch(/Fire drill at 10/)
    expect(screen.queryByRole('button', { name: 'Edit shift' })).toBeNull()
  })

  it('a manager edits the shift: PUT to the block, only the changed field, then a toast', async () => {
    await openShift(MANAGER)
    fireEvent.click(screen.getByRole('button', { name: 'Edit shift' }))
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '09:30' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save shift' })) })
    const put = global.fetch.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(put[0]).toBe('/api/schedule/blocks/b1')
    expect(JSON.parse(put[1].body)).toEqual({ start_time: '09:30', expected: { start_time: '09:00', end_time: '12:00', min_coaches: 1, max_coaches: 3 } })
    expect(await screen.findByText('Saved. The coach on this shift will be told in the next few minutes.')).toBeTruthy()
  })

  it('while the form is open a backdrop click does not throw it away', async () => {
    await openShift(MANAGER)
    fireEvent.click(screen.getByRole('button', { name: 'Edit shift' }))
    expect(screen.getByRole('form', { name: 'Edit shift' })).toBeTruthy()
    // Modal's dismissOnBackdrop is false while editing (ROSTER-FIX.6b-7
    // pattern, the a11y suite's backdrop gesture): the dialog stays.
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement)
    expect(screen.getByRole('form', { name: 'Edit shift' })).toBeTruthy()
    // Escape still closes: dismissOnBackdrop, never dismissable={false}.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
