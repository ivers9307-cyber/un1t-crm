// @vitest-environment jsdom
//
// ROSTER-FIX.6a — every schedule manager screen fetched with no try/catch and
// cleared `loading` on the happy path only, so a dropped network or a 500 left
// the operator on "Loading requests..." / "Loading templates..." forever with
// nothing explaining it (memory: discarded-error defect class). Two of the
// sites discarded the response entirely: ShiftTemplateManager's deactivate and
// reactivate both `await fetch(...)` and then refetched regardless, so a
// refused delete looked exactly like a successful one.
//
// One test per screen: a failed load must NAME the failure, offer a retry and
// never leave a Loading string on the page.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/schedule',
}))

import TimeOffManager from './TimeOffManager.jsx'
import ShiftTemplateManager from './ShiftTemplateManager.jsx'
import SwapRequestsManager from './SwapRequestsManager.jsx'
import ScheduleReporting from './ScheduleReporting.jsx'

const user = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const ok = (body) => ({ ok: true, status: 200, json: async () => body })

function failWith(kind) {
  if (kind === 'throw') return vi.fn(async () => { throw new TypeError('Failed to fetch') })
  return vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Database is unavailable' }) }))
}

beforeEach(() => { global.fetch = vi.fn(async () => ok({ data: [] })) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const SCREENS = [
  { name: 'TimeOffManager', Component: TimeOffManager, loadingText: /Loading requests/ },
  { name: 'ShiftTemplateManager', Component: ShiftTemplateManager, loadingText: /Loading templates/ },
  { name: 'SwapRequestsManager', Component: SwapRequestsManager, loadingText: /Loading requests/ },
  { name: 'ScheduleReporting', Component: ScheduleReporting, loadingText: /Loading report history/ },
]

describe.each(SCREENS)('$name load failures', ({ Component, loadingText }) => {
  it('names a server error instead of hanging on Loading', async () => {
    global.fetch = failWith('500')
    render(<Component user={user} />)
    await waitFor(() => expect(screen.getByText('Database is unavailable')).toBeTruthy())
    expect(screen.queryByText(loadingText)).toBeNull()
    expect(screen.getByText('Retry')).toBeTruthy()
  })

  it('reports a dropped network instead of hanging on Loading', async () => {
    global.fetch = failWith('throw')
    render(<Component user={user} />)
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy())
    expect(screen.queryByText(loadingText)).toBeNull()
  })

  it('retries the load on demand', async () => {
    global.fetch = failWith('throw')
    render(<Component user={user} />)
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy())
    global.fetch = vi.fn(async () => ok({ data: [] }))
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(screen.queryByText('Retry')).toBeNull())
  })

  it('shows no error banner on a healthy load', async () => {
    render(<Component user={user} />)
    await waitFor(() => expect(screen.queryByText(loadingText)).toBeNull())
    expect(screen.queryByText('Retry')).toBeNull()
  })
})

describe('ShiftTemplateManager discarded responses (ROSTER-FIX.6a)', () => {
  const template = {
    id: 't1', name: 'Morning', start_time: '06:00:00', end_time: '14:00:00',
    color: '#3B82F6', active: true, days_of_week: ['mon'], max_coaches: 3, min_coaches: 1,
  }

  it('reports a refused deactivate instead of silently refetching', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    global.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === 'DELETE') return { ok: false, status: 403, json: async () => ({ error: 'Not your location' }) }
      return ok({ data: [template] })
    })
    render(<ShiftTemplateManager user={user} />)
    await waitFor(() => expect(screen.getByText('Morning')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Deactivate'))
    await waitFor(() => expect(screen.getByText('Not your location')).toBeTruthy())
  })

  it('reports a refused reactivate instead of silently refetching', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === 'PUT') return { ok: false, status: 403, json: async () => ({ error: 'Not your location' }) }
      // The Inactive list only renders alongside at least one active
      // template, so the fixture carries both.
      return ok({ data: [template, { ...template, id: 't2', name: 'Evening', active: false }] })
    })
    render(<ShiftTemplateManager user={user} />)
    await waitFor(() => expect(screen.getByText('Reactivate')).toBeTruthy())
    fireEvent.click(screen.getByText('Reactivate'))
    await waitFor(() => expect(screen.getByText('Not your location')).toBeTruthy())
  })
})

describe('TimeOffManager review actions (ROSTER-FIX.6a)', () => {
  const request = {
    id: 'r1', profile_id: 'u2', type: 'holiday', status: 'pending',
    start_date: '2026-06-01', end_date: '2026-06-03', total_days: 3,
    profiles: { full_name: 'Aoife' },
  }

  it('reports a refused approval and does not leave the row busy', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === 'PUT') return { ok: false, status: 409, json: async () => ({ error: 'Allowance exhausted' }) }
      return ok({ data: [request] })
    })
    render(<TimeOffManager user={user} />)
    // The default tab is "my", which hides the name; the Approve control is
    // the stable handle on the row.
    await waitFor(() => expect(screen.getByTitle('Approve')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Approve'))
    await waitFor(() => expect(screen.getByText('Allowance exhausted')).toBeTruthy())
    // The button is usable again, so the manager can act on the real reason.
    expect(screen.getByTitle('Approve').disabled).toBe(false)
  })
})

describe('SwapRequestsManager review actions (ROSTER-FIX.6a)', () => {
  it('reports a network failure instead of swallowing it', async () => {
    const swap = {
      id: 's1', status: 'pending', requester_id: 'u2',
      requester: { full_name: 'Aoife' },
      requester_shift: { shift_date: '2026-06-01', shift_templates: { name: 'Morning', start_time: '06:00:00', end_time: '14:00:00' } },
    }
    let first = true
    global.fetch = vi.fn(async (url, opts) => {
      if (opts?.method === 'PUT') throw new TypeError('Failed to fetch')
      first = false
      return ok({ data: [swap] })
    })
    render(<SwapRequestsManager user={user} />)
    await waitFor(() => expect(screen.getByText('Aoife')).toBeTruthy())
    expect(first).toBe(false)
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => expect(screen.getByText(/Network error/)).toBeTruthy())
  })
})
