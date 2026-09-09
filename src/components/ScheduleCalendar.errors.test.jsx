// @vitest-environment jsdom
//
// ROSTER-FIX.6a — the operator-visible half of the data-layer fix. Pins:
//   - a failed load ends on a named banner with a Retry, never on a permanent
//     "Loading roster..."
//   - Retry re-runs the fetch
//   - the leave-page guard is keyed to the period ON SCREEN, so publishing one
//     week no longer silences a warning about a different, still-dirty week
//     (and a clean week no longer inherits another week's warning)

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams('view=week&week=2026-05-04&month=2026-05-01'),
}))
// Not under test here and it renders its own money panels; keep the DOM small.
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

const user = {
  id: 'u1',
  role: 'manager',
  activeLocation: { id: 'loc1', name: 'Stillorgan' },
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

function happyFetch() {
  return vi.fn(async (url) => {
    if (url.includes('/schedule/blocks')) return okResponse({ data: [] })
    if (url.includes('contractor-spend')) return okResponse({ success: true, data: {} })
    // Mutations answer {success:true}; a bare {data:[]} would be treated as a
    // failure by the wrapped handlers, which is the point of the wrapping.
    if (url.includes('/copy-week') || url.includes('/copy-month')) return okResponse({ success: true, copied: 3 })
    return okResponse({ data: [] })
  })
}

beforeEach(() => { global.fetch = happyFetch() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ScheduleCalendar load failures (ROSTER-FIX.6a)', () => {
  it('shows a dismissible error banner instead of hanging on Loading', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<ScheduleCalendar user={user} />)

    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
    expect(screen.queryByText(/Loading roster/)).toBeNull()

    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('Could not load the roster')).toBeNull()
  })

  it('names the server error and retries on demand', async () => {
    global.fetch = vi.fn(async (url) =>
      url.includes('/schedule/blocks')
        ? { ok: false, status: 403, json: async () => ({ error: 'Not your location' }) }
        : okResponse({ data: [] })
    )
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.getByText('Not your location')).toBeTruthy())

    global.fetch = happyFetch()
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(screen.queryByText('Not your location')).toBeNull())
    expect(global.fetch).toHaveBeenCalled()
  })

  it('does not render the banner on a healthy load', async () => {
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByText('Could not load the roster')).toBeNull()
  })
})

describe('per-period unpublished-changes guard (ROSTER-FIX.6a)', () => {
  // The guard used to be one boolean for the whole screen. Editing week A and
  // then paging to week B carried A's warning onto B, and publishing B cleared
  // the warning A still deserved. It is now keyed by the visible period.
  async function renderWithDirtyWeek() {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    // Copy last week is a real mutation, so it marks the visible week dirty.
    fireEvent.click(screen.getByText('Copy Last Week'))
    // The period is marked dirty only after the post-mutation refetch resolves,
    // so wait for the SECOND blocks read, not just the copy-week POST.
    const blockReads = () => global.fetch.mock.calls.filter(c => String(c[0]).includes('/schedule/blocks')).length
    await waitFor(() => expect(blockReads()).toBe(2))
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }

  it('warns when leaving with the dirty week on screen', async () => {
    await renderWithDirtyWeek()
    window.confirm.mockClear()
    fireEvent.click(screen.getByText('Time Off').closest('a'))
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('unpublished roster changes')
    ))
  })

  it('stays quiet once the operator moves to a different, clean period', async () => {
    await renderWithDirtyWeek()
    // "Today" is a period change like the arrows are (the fixture week is
    // 2026-05-04, deliberately not the current one) and has a stable label;
    // the arrows get their aria-labels in 6b.
    fireEvent.click(screen.getByText('Today'))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    window.confirm.mockClear()
    fireEvent.click(screen.getByText('Time Off').closest('a'))
    expect(window.confirm).not.toHaveBeenCalled()
  })
})
