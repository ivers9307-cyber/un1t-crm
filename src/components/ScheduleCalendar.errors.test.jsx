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
    // 500, not 403: since ROSTER-FIX.6a-8 a 401/403 is reported as a dead
    // session rather than in the server's words (pinned in
    // schedule/useScheduleData.test.js), and this case is about the words.
    global.fetch = vi.fn(async (url) =>
      url.includes('/schedule/blocks')
        ? { ok: false, status: 500, json: async () => ({ error: 'Not your location' }) }
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
  let rerender
  async function renderWithDirtyWeek() {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    ;({ rerender } = render(<ScheduleCalendar user={user} />))
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

  // ROSTER-FIX.6a-7 — the per-period rewrite matched keys EXACTLY, so this
  // switch (week 4-10 May -> month 1-31 May, same unpublished edits still on
  // screen) silently lost the warning the old screen-wide boolean gave. The
  // guard now warns on any OVERLAP.
  it('still warns after switching the dirty week into Month view', async () => {
    await renderWithDirtyWeek()
    fireEvent.click(screen.getByText('Month'))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    window.confirm.mockClear()
    fireEvent.click(screen.getByText('Time Off').closest('a'))
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('unpublished roster changes')
    ))
  })

  it('still warns after switching back from Month to Week', async () => {
    await renderWithDirtyWeek()
    fireEvent.click(screen.getByText('Month'))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    fireEvent.click(screen.getByText('Week'))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    window.confirm.mockClear()
    fireEvent.click(screen.getByText('Time Off').closest('a'))
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('unpublished roster changes')
    ))
  })

  // A publish clears only what it FULLY covered (clearDirtyPeriodsCoveredBy);
  // the predicate itself is pinned in src/lib/roster.test.js, this is the
  // wiring.
  it('goes quiet once the dirty week is published', async () => {
    await renderWithDirtyWeek()
    global.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('/schedule/rosters')) {
        const body = JSON.parse(opts?.body || '{}')
        return body.dry_run
          ? okResponse({ success: true, impact: { blockCount: 1, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: 100 } })
          : okResponse({ success: true, impact: {} })
      }
      return okResponse({ data: [] })
    })
    fireEvent.click(screen.getByText('Publish'))
    // The modal runs its own dry-run budget preview first; its confirm button
    // only renders once that lands, and carries the same label as the toolbar
    // button that opened it, so wait for the preview and take the last match.
    await screen.findByText('Publish roster', {}, { timeout: 5000 })
    await waitFor(() => expect(screen.getByText('Blocks in period')).toBeTruthy(), { timeout: 5000 })
    const buttons = screen.getAllByText('Publish')
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(screen.queryByText('Publish roster')).toBeNull(), { timeout: 5000 })

    window.confirm.mockClear()
    fireEvent.click(screen.getByText('Time Off').closest('a'))
    expect(window.confirm).not.toHaveBeenCalled()
  })

  // Switching location swaps the roster out from under the guard, so the old
  // location's dirty periods are no longer reachable from this screen.
  it('drops every dirty period when the active location changes', async () => {
    await renderWithDirtyWeek()
    rerender(<ScheduleCalendar user={{ ...user, activeLocation: { id: 'loc2', name: 'Hatch Street' } }} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    window.confirm.mockClear()
    fireEvent.click(screen.getByText('Time Off').closest('a'))
    expect(window.confirm).not.toHaveBeenCalled()
  })
})

// ROSTER-FIX.6a-8 — the toast was a bare { kind, message }. Two identical
// failures wrote an equal-looking object, so the second click produced no
// visible change at all and read as "nothing happened"; and every toast,
// success included, sat there until something replaced it.
describe('toasts (ROSTER-FIX.6a-8)', () => {
  function copyMonthFetch(answer) {
    return vi.fn(async (url) => {
      if (String(url).includes('/copy-month')) return answer()
      if (String(url).includes('contractor-spend')) return okResponse({ success: true, data: {} })
      return okResponse({ data: [] })
    })
  }

  async function renderReady() {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
  }

  it('gives two identical failures two distinct toast ids', async () => {
    global.fetch = copyMonthFetch(() => ({ ok: false, status: 500, json: async () => ({ error: 'Copy failed' }) }))
    await renderReady()

    fireEvent.click(screen.getByText('Copy Last Month'))
    await waitFor(() => expect(screen.getByText('Copy failed')).toBeTruthy())
    const firstId = document.querySelector('[data-toast-id]').getAttribute('data-toast-id')

    fireEvent.click(screen.getByText('Copy Last Month'))
    await waitFor(() =>
      expect(document.querySelector('[data-toast-id]').getAttribute('data-toast-id')).not.toBe(firstId)
    )
    expect(screen.getByText('Copy failed')).toBeTruthy()
  })

  it('expires a non-error toast on its own timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      // copy-month with skipped rows reports a warning toast, which is the
      // shortest path to a self-expiring one.
      global.fetch = copyMonthFetch(() => okResponse({ success: true, copied: 3, skipped: 1 }))
      await renderReady()

      fireEvent.click(screen.getByText('Copy Last Month'))
      await waitFor(() => expect(screen.getByText(/1 skipped/)).toBeTruthy())

      await act(async () => { await vi.advanceTimersByTimeAsync(6001) })
      expect(screen.queryByText(/1 skipped/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an error toast up until the operator dismisses it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      global.fetch = copyMonthFetch(() => ({ ok: false, status: 500, json: async () => ({ error: 'Copy failed' }) }))
      await renderReady()

      fireEvent.click(screen.getByText('Copy Last Month'))
      await waitFor(() => expect(screen.getByText('Copy failed')).toBeTruthy())

      // A failed mutation is still the operator's to act on, so it must not
      // time out - a toast that vanishes is a discarded error with extra steps.
      await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
      expect(screen.getByText('Copy failed')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
