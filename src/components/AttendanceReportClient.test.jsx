// @vitest-environment jsdom
//
// ATTENDREPORT.1 (follow-ups C4) — the attendance page's wiring. The rules are
// tested in src/lib/attendance-report.test.js; this pins what the page does
// with the answer: it asks for the Dublin default window, shows the start the
// coach was given (with an "adjusted" marker), says when the Source badges may
// be incomplete, and never shows "No shifts in this window." or the previous
// window's rows after a failed load. Synthetic names only (public repo).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import AttendanceReportClient from './AttendanceReportClient'
import { dublinTodayStr } from '@/lib/dublin-time'
import { defaultAttendancePeriod } from '@/lib/attendance-report'

const ROW = {
  assignment_id: 'a1', profile_id: 'p-a', profile_name: 'Coach A', profile_role: 'staff',
  block_date: '2026-07-15', scheduled_start: '07:00:00', scheduled_end: '10:00:00',
  effective_start: '08:00:00', effective_end: '10:00:00', start_adjusted: true,
  scheduled_at: '2026-07-15T07:00:00.000Z', arrival_at: '2026-07-15T06:50:00.000Z',
  actual_start: '07:50:00', arrival_inferred: false, paid_start_override: '08:00:00',
  status: 'on_time', minutes_late: -10, sources: ['geofence'],
}
const SUMMARY = { total: 1, on_time: 1, late: 0, no_show: 0, pending: 0 }
const ok = (body) => Promise.resolve({ json: () => Promise.resolve({ success: true, rows: [ROW], summary: SUMMARY, warnings: [], ...body }) })
const fail = (error) => Promise.resolve({ json: () => Promise.resolve({ success: false, error }) })

// Unmount AFTER each test, so the last test's tree is gone before jsdom is
// torn down (see tests/rtl-cleanup-after-each.test.js).
afterEach(cleanup)
afterEach(() => vi.unstubAllGlobals())

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

describe('AttendanceReportClient (ATTENDREPORT.1)', () => {
  it('asks for the Dublin default window, both ends', async () => {
    // 00:30 on 15 Jul in Dublin is still 14 Jul in UTC. Only Date is faked:
    // RTL's polling keeps the real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-14T23:30:00Z'))
    try {
      fetchMock.mockReturnValue(ok())
      render(<AttendanceReportClient activeLocationName="Studio One" />)
      await screen.findByText('Coach A')
      const url = new URL(fetchMock.mock.calls[0][0])
      expect({ from: url.searchParams.get('from'), to: url.searchParams.get('to') })
        .toEqual({ from: '2026-07-01', to: '2026-07-15' })
      expect(defaultAttendancePeriod(dublinTodayStr())).toEqual({ from: '2026-07-01', to: '2026-07-15' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the start the coach was given, marked adjusted with the rostered time', async () => {
    fetchMock.mockReturnValue(ok())
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    const marker = await screen.findByText('adjusted')
    expect(marker.getAttribute('title')).toBe('Rostered 07:00')
    expect(marker.parentElement.textContent).toBe('08:00adjusted')
  })

  // Review N1: pending/no-show is judged on the effective END, so show it.
  it('shows an adjusted end, and says when it runs into the next day', async () => {
    fetchMock.mockReturnValue(ok({ rows: [
      { ...ROW, effective_end: '11:00:00', end_adjusted: true, end_next_day: false },
      { ...ROW, assignment_id: 'a2', profile_name: 'Coach B', block_date: '2026-07-14', start_adjusted: false,
        scheduled_start: '20:00:00', scheduled_end: '21:00:00', effective_start: '20:00:00', effective_end: '00:30:00',
        end_adjusted: true, end_next_day: true },
    ] }))
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    const later = await screen.findByText('ends 11:00')
    expect(later.getAttribute('title')).toBe('Rostered end 10:00')
    expect(later.parentElement.textContent).toBe('08:00adjustedends 11:00')
    const wraps = screen.getByText('ends 00:30 next day')
    expect(wraps.getAttribute('title')).toBe('Rostered end 21:00')
    expect(wraps.parentElement.textContent).toBe('20:00ends 00:30 next day')
  })

  it('an unchanged end says nothing', async () => {
    fetchMock.mockReturnValue(ok({ rows: [{ ...ROW, end_adjusted: false, end_next_day: false }] }))
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    await screen.findByText('Coach A')
    expect(screen.queryByText(/^ends /)).toBeNull()
  })

  it('says when the Source badges may be incomplete', async () => {
    fetchMock.mockReturnValue(ok({ warnings: ['sources_unavailable'] }))
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    expect(await screen.findByText(/some Source badges may be missing/)).toBeTruthy()
  })

  it('a failed load shows the error, never the empty-table line or the last window\'s rows', async () => {
    fetchMock.mockReturnValueOnce(ok()).mockReturnValueOnce(fail('Could not load the attendance report. Try again.'))
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    await screen.findByText('Coach A')
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await screen.findByText('Could not load the attendance report. Try again.')
    expect(screen.queryByText('Coach A')).toBeNull()
    expect(screen.queryByText('No shifts in this window.')).toBeNull()
  })

  // Review: a slow earlier request must never land over a later one.
  it('overlapping loads: only the latest request\'s answer shows', async () => {
    const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
    const slow = deferred()
    fetchMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fail('to must be on or after from'))
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    // Window B: the second request answers first, with a 400.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } })
    await screen.findByText('to must be on or after from')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Window A's slow success lands afterwards: dropped.
    await act(async () => { slow.resolve({ json: () => Promise.resolve({ success: true, rows: [ROW], summary: SUMMARY, warnings: [] }) }) })
    expect(screen.queryByText('Coach A')).toBeNull()
    expect(screen.getByText('to must be on or after from')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(false)
  })

  it('overlapping loads: a stale failure never clears the latest rows, and only the latest ends loading', async () => {
    const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
    const slow = deferred()
    const fast = deferred()
    fetchMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The older request fails first: the newer one is still loading.
    await act(async () => { slow.resolve({ json: () => Promise.resolve({ success: false, error: 'stale failure' }) }) })
    expect(screen.queryByText('stale failure')).toBeNull()
    expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(true)
    await act(async () => { fast.resolve({ json: () => Promise.resolve({ success: true, rows: [ROW], summary: SUMMARY, warnings: [] }) }) })
    expect(screen.getByText('Coach A')).toBeTruthy()
    expect(screen.queryByText('stale failure')).toBeNull()
    expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(false)
  })

  it('an empty window still says so', async () => {
    fetchMock.mockReturnValue(ok({ rows: [], summary: { ...SUMMARY, total: 0, on_time: 0 } }))
    render(<AttendanceReportClient activeLocationName="Studio One" />)
    expect(await screen.findByText('No shifts in this window.')).toBeTruthy()
  })
})
