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

// 🔴 THE TEST BUDGET MUST EXCEED THE WAITS THIS FILE DECLARES.
//
// vitest's default per-test timeout is 5000ms and nothing in vitest.config.js
// raises it, so a `waitFor(..., { timeout: 5000 })` inside a test is a budget
// that can never be reached: the TEST aborts first, with "Test timed out in
// 5000ms" — which reads as a broken assertion rather than a starved one.
//
// On an idle machine every wait here resolves in about a tenth of a second, so
// this passed locally and in isolation forever. Under a full-suite run, with
// many jsdom environments competing for the box, the cumulative time crosses
// 5s and the test dies — the intermittent red that could never be reproduced.
// Proven by construction: an inner 5000ms wait under a 1000ms test budget
// fails at 1000ms, not 5000.
//
// So the file's budget is set above the sum of the waits its own tests declare.
//
// THIS ESTATE HAS BEEN HERE BEFORE. AudienceCount.test.jsx carries the same
// vi.setConfig and a comment recording that it "went flaky roughly 1 run in 8
// before these were widened". That fix never became a rule, so the next file
// to declare a generous inner wait — this one — inherited the same latent
// flake. tests/test-timeout-budgets.test.js is the rule.
vi.setConfig({ testTimeout: 20000 })

const DEFAULT_SEARCH = 'view=week&week=2026-05-04&month=2026-05-01'
// Mutable so one test can start the calendar on a different week without a
// second mock of next/navigation.
const nav = vi.hoisted(() => ({ search: 'view=week&week=2026-05-04&month=2026-05-01' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(nav.search),
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

beforeEach(() => { global.fetch = happyFetch(); nav.search = DEFAULT_SEARCH })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ScheduleCalendar load failures (ROSTER-FIX.6a)', () => {
  it('shows a dismissible error banner instead of hanging on Loading', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<ScheduleCalendar user={user} />)

    // ROSTER-FIX.6a-11 — assert the WHOLE contract inside one waitFor. The
    // banner and the cleared loading flag are two setState calls (catch then
    // finally), so a poll that lands between them saw the banner with
    // "Loading roster..." still on screen and failed on a machine under load.
    // Both conditions together still fail if loading never clears, which is
    // the hang this test exists to catch.
    await waitFor(() => {
      expect(screen.getByText('Could not load the roster')).toBeTruthy()
      expect(screen.queryByText(/Loading roster/)).toBeNull()
    })

    // No settling step before this click, deliberately. It used to need one,
    // and that was the tell: the dismissal was keyed on `error`'s identity,
    // which refresh() churns null -> message on every cycle, so a background
    // refresh re-raised the identical banner and the test had to out-wait it.
    // A test waiting for a product bug to stop happening is not a passing
    // test. ROSTER-FIX.6a-13 keyed the dismissal on the MESSAGE instead, so
    // dismissing now sticks through repeats of the same failure and this
    // asserts the behaviour rather than a quiet moment.
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByText('Could not load the roster')).toBeNull())
  })

  it('a dismissed banner stays dismissed through repeats of the SAME failure', async () => {
    // ROSTER-FIX.6a-13. The comment on errorDismissed has always promised the
    // operator can "clear a banner without it reappearing until the next
    // failure". It did not: the reset was keyed on `error`'s identity, and
    // refresh() churns it null -> message every cycle, so a background refresh
    // nobody asked for re-raised the identical banner. Dismiss was, in effect,
    // a button that worked until the next tick.
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByText('Could not load the roster')).toBeNull())

    // Drive another failing load — the same failure, unasked for. The banner
    // must stay gone: a repeat carries no information the operator has not
    // already read and dismissed.
    fireEvent.click(screen.getByText('Today'))
    await act(async () => {})
    expect(screen.queryByText('Could not load the roster')).toBeNull()
  })

  it('a DIFFERENT failure re-raises it, because that is new information', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByText('Could not load the roster')).toBeNull())

    global.fetch = vi.fn(async (url) =>
      String(url).includes('/schedule/blocks')
        ? { ok: false, status: 500, json: async () => ({ error: 'Not your location' }) }
        : okResponse({ data: [] })
    )
    fireEvent.click(screen.getByText('Today'))
    await waitFor(() => expect(screen.getByText(/Not your location/)).toBeTruthy())
  })

  it('the SAME failure after a load that worked re-raises it', async () => {
    // The half a message-only check would miss. A failure dismissed this
    // morning must not silence an identical failure this afternoon: everything
    // worked in between, so the second one is news. This is why the dismissal
    // remembers the hook's success count and not just the words.
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByText('Could not load the roster')).toBeNull())

    // A load that works.
    global.fetch = happyFetch()
    fireEvent.click(screen.getByText('Today'))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())

    // Then the same failure again — it must speak up.
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    fireEvent.click(screen.getByText('Month'))
    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
  })

  it('shows Retrying… on the banner while a retry is in flight', () => {
    // ScheduleErrorBanner renders 'Retrying…' and disables its own button when
    // `busy`, and the calendar passes it `loading`. Whether an operator ever
    // SEES that is a different question: refresh() clears `error` before it
    // starts, and the banner only renders `error && !errorDismissed`.
    return (async () => {
      let release
      global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
      render(<ScheduleCalendar user={user} />)
      await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())

      // A retry that does not resolve, so the in-flight state is observable.
      global.fetch = vi.fn(() => new Promise((resolve) => { release = resolve }))
      fireEvent.click(screen.getByText('Retry'))
      await act(async () => {})
      expect(screen.queryByText('Retrying…')).toBeTruthy()
      release?.({ ok: true, status: 200, json: async () => ({ data: [] }) })
    })()
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
    const blockLoads = () => global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/schedule/blocks')).length
    const loadsBeforePublish = blockLoads()
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(screen.queryByText('Publish roster')).toBeNull(), { timeout: 5000 })

    // 🔴 THE MODAL CLOSING IS NOT PROOF THE PUBLISH FINISHED, and treating it
    // as proof is what made this test fail in CI while passing locally. The
    // handler does three things in a row — setPublishModal(null), then
    // refreshAfterMutation(), then clearDirtyPeriodsCoveredBy() — and the wait
    // above observes only the FIRST. Under load the click below could land
    // between them, with the guard still armed, and the failure read as "the
    // guard is broken" rather than "the test asked too early".
    //
    // refreshAfterMutation() is the statement immediately before the dirty
    // clear and is not awaited, so once its blocks fetch has been ISSUED the
    // clear has necessarily already run. Waiting on that is a direct
    // observation of the thing under test, not a sleep.
    await waitFor(() => expect(blockLoads()).toBeGreaterThan(loadsBeforePublish), { timeout: 5000 })
    await act(async () => {})

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

// ROSTER-FIX.6a-9 (F3) — the Month/Week toggle moved to the midweek rule in
// 6a-1, but the publish modal and Copy Last Month kept their own
// getMonthStart(weekStart), which takes the month of the week's MONDAY. On the
// week of Mon 31 Aug 2026 the header therefore said September while Publish
// and Copy offered August: one screen, two answers to "which month is this".
describe('one month rule across toggle, publish and copy (ROSTER-FIX.6a-9)', () => {
  // Mon 31 Aug 2026 - Sun 6 Sep 2026. Only one day of it is in August.
  const STRADDLING_WEEK = 'view=week&week=2026-08-31&month=2026-08-01'

  async function renderStraddlingWeek() {
    nav.search = STRADDLING_WEEK
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
  }

  it('the publish modal offers the month the toggle would show', async () => {
    await renderStraddlingWeek()
    fireEvent.click(screen.getByText('Publish'))
    await screen.findByText('Publish roster', {}, { timeout: 5000 })
    fireEvent.click(screen.getByText('This month'))
    await waitFor(() => expect(screen.getByText('September 2026')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText('August 2026')).toBeNull()
  })

  it('Copy Last Month targets September and reads from August', async () => {
    await renderStraddlingWeek()
    fireEvent.click(screen.getByText('Copy Last Month'))
    expect(window.confirm).toHaveBeenCalledWith(
      "Copy last month's roster (August 2026) to September 2026?"
    )
  })

  it('the Month toggle agrees with both', async () => {
    await renderStraddlingWeek()
    fireEvent.click(screen.getByText('Month'))
    await waitFor(() => expect(screen.getByText('September 2026')).toBeTruthy())
  })
})

// ROSTER-FIX.6a-9 (finding 4) — the banner must say whether the grid under it
// is real. Silence there is how an empty grid gets read as "nobody is
// rostered".
describe('the banner says when it is covering stale data (ROSTER-FIX.6a-9)', () => {
  const STALE_LINE = /Showing the last data that loaded/

  it('says so when the last good week is still underneath', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let blockReads = 0
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/schedule/blocks')) {
        blockReads += 1
        if (blockReads > 1) throw new TypeError('Failed to fetch')
        return okResponse({ data: [{ id: 'b1', block_date: '2026-05-04', shift_assignments: [] }] })
      }
      if (u.includes('contractor-spend')) return okResponse({ success: true, data: {} })
      if (u.includes('/copy-week')) return okResponse({ success: true, copied: 3 })
      return okResponse({ data: [] })
    })
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())

    // A mutation refetches the SAME week; that refetch fails.
    fireEvent.click(screen.getByText('Copy Last Week'))
    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
    expect(screen.getByText(STALE_LINE)).toBeTruthy()
  })

  it('stays quiet about stale data when there is none to show', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<ScheduleCalendar user={user} />)
    await waitFor(() => expect(screen.getByText('Could not load the roster')).toBeTruthy())
    expect(screen.queryByText(STALE_LINE)).toBeNull()
  })
})
