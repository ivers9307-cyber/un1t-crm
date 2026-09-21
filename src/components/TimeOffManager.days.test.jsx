// @vitest-environment jsdom
//
// LEAVEDAYS.1 — the leave form's "days requested" line is the SERVER's number
// (GET /api/schedule/time-off?preview=1), not a calendar count made in the
// browser. The decisions live in src/lib/leave-days-preview.js with their own
// unit tests; this file proves the WIRING: the debounce, that the last request
// wins, which studio is asked, and that the form still submits what it did.
//
// Fake clock throughout, and every move of it is inside act() (CLAUDE.md;
// tests/fake-timer-act.test.js). No findBy*/waitFor: under a plain
// vi.useFakeTimers() they await a faked setTimeout(0) and hang.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

import TimeOffManager from '@/components/TimeOffManager'
import { LEAVE_PREVIEW_DEBOUNCE_MS as DEBOUNCE } from '@/lib/leave-days-preview'

const COACH = { id: 'u1', role: 'staff', employment_type: 'fte', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const APPROVER = { ...COACH, role: 'head_coach' }
const STAFF = [{ id: 'f1', full_name: 'Fiona FTE', employment_type: 'fte', active: true }]

// 26 Oct 2026 is the October bank holiday: Mon-Fri is 5 calendar days, 4 charged.
const previewBody = (total, year = 2026) => ({
  success: true,
  data: {
    type: 'holiday', start_date: '2026-10-26', end_date: '2026-10-30',
    days: { total, segments: [{ year, start_date: '2026-10-26', end_date: '2026-10-30', days: total }] },
    // The CALLER's own shifts. Never to be shown by this form.
    clashes: [{ id: 'a1', block_date: '2026-10-27', start_time: '06:30:00', template_name: 'Opening shift', location_name: 'Stillorgan' }],
  },
})

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

/** `onPreview(url, n)` returns a response or a promise of one; n counts preview calls from 1. */
function mockFetch({ remaining = 16, onPreview, staff = [], posted = [] } = {}) {
  const previews = []
  global.fetch = vi.fn(async (url, opts = {}) => {
    if (opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return json({ success: true, data: { id: 'new' } }) }
    if (url.includes('allowance')) return json({ success: true, data: { year: 2026, total_days: 20, used_days: 20 - remaining, carried_over: 0, remaining } })
    if (url.includes('/api/staff')) return json({ success: true, data: staff })
    if (url.includes('preview=1')) {
      previews.push({ url, signal: opts.signal })
      return onPreview(url, previews.length)
    }
    return json({ success: true, data: [] })
  })
  return previews
}

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const later = (ms, body) => new Promise((resolve) => setTimeout(() => resolve(json(body)), ms))

async function openForm(user = COACH, props = {}) {
  await act(async () => { render(<TimeOffManager user={user} canApprove={false} {...props} />) })
  await advance(0)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Request Time Off/ })) })
  await advance(0)
  const dialog = screen.getByRole('dialog')
  const [start, end] = dialog.querySelectorAll('input[type="date"]')
  return { dialog, start, end }
}

const setDate = (input, value) => act(async () => { fireEvent.change(input, { target: { value } }) })

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-21T10:00:00Z')) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('TimeOffManager — LEAVEDAYS.1, the form shows what the server will charge', () => {
  it('a bank-holiday week reads 4 days and is NOT flagged, where the calendar count said 5 and "exceeds balance"', async () => {
    const previews = mockFetch({ remaining: 4, onPreview: () => json(previewBody(4)) })
    const { dialog, start, end } = await openForm()
    await setDate(start, '2026-10-26')
    await setDate(end, '2026-10-30')

    // Until the server answers there is no number at all.
    expect(dialog.textContent).toContain('Counting days...')
    expect(dialog.textContent).not.toMatch(/\d+ days? requested/)
    expect(previews).toHaveLength(0)

    await advance(DEBOUNCE)
    expect(previews).toHaveLength(1)
    // The studio the POST files at, and nobody's profile.
    expect(previews[0].url).toBe('/api/schedule/time-off?preview=1&type=holiday&start_date=2026-10-26&end_date=2026-10-30&location_id=loc1')
    expect(dialog.textContent).toContain('4 days requested')
    expect(dialog.textContent).toContain('4 remaining')
    expect(dialog.textContent).not.toContain('exceeds balance')
    expect(dialog.textContent).not.toContain('5 days')
    expect(dialog.textContent).toContain('Weekends, bank holidays and days the studio is closed are not charged.')
  })

  it('flags "exceeds balance" when the SERVER\'s number does', async () => {
    mockFetch({ remaining: 3, onPreview: () => json(previewBody(4)) })
    const { dialog, start, end } = await openForm()
    await setDate(start, '2026-10-26')
    await setDate(end, '2026-10-30')
    await advance(DEBOUNCE)
    expect(dialog.textContent).toContain('4 days requested')
    expect(screen.getByText('(exceeds balance)').className).toContain('text-red-700')
  })

  it('debounces: a burst of date changes asks once, for the last range', async () => {
    const previews = mockFetch({ onPreview: () => json(previewBody(3)) })
    const { start, end } = await openForm()
    await setDate(start, '2026-10-26')
    await advance(DEBOUNCE - 1)
    await setDate(end, '2026-10-27')
    await advance(DEBOUNCE - 1)
    await setDate(end, '2026-10-28')
    await advance(DEBOUNCE - 1)
    expect(previews).toHaveLength(0)
    await advance(1)
    expect(previews.map((p) => p.url)).toEqual([expect.stringContaining('start_date=2026-10-26&end_date=2026-10-28')])
  })

  it('the last request wins: a slow answer for an older range never overwrites the newer one', async () => {
    // First preview answers LATE with 9; the second answers fast with 4. The
    // mock ignores the abort on purpose, so the stale body really does arrive.
    const previews = mockFetch({ onPreview: (url, n) => (n === 1 ? later(2000, previewBody(9)) : later(50, previewBody(4))) })
    const { dialog, start, end } = await openForm()
    await setDate(start, '2026-10-26')
    await setDate(end, '2026-11-06')
    await advance(DEBOUNCE)                 // preview 1 in flight
    expect(previews).toHaveLength(1)

    await setDate(end, '2026-10-30')
    expect(dialog.textContent).toContain('Counting days...')
    await advance(DEBOUNCE)                 // preview 2 in flight
    expect(previews).toHaveLength(2)
    expect(previews[0].signal.aborted).toBe(true)
    await advance(50)
    expect(dialog.textContent).toContain('4 days requested')

    await advance(2000)                     // the stale 9 lands now
    expect(dialog.textContent).toContain('4 days requested')
    expect(dialog.textContent).not.toContain('9 days')
  })

  it('a range the server prices at 0 says so plainly', async () => {
    mockFetch({ onPreview: () => json(previewBody(0)) })
    const { dialog, start } = await openForm()
    await setDate(start, '2026-10-26')
    await advance(DEBOUNCE)
    expect(dialog.textContent).toContain('No working days in that range')
    expect(dialog.textContent).not.toContain('requested')
    expect(dialog.textContent).not.toContain('remaining')
  })

  it.each([
    ['a deployment without the preview (it answers with the request list)', () => json({ success: true, data: [{ id: 'r1' }] })],
    ['a preview that failed closed', () => json({ success: false, error: 'holidays unreadable' }, 500)],
    ['a dropped network', () => Promise.reject(new Error('offline'))],
  ])('%s: calendar days, named as such, and no "exceeds balance"', async (_, onPreview) => {
    mockFetch({ remaining: 2, onPreview })
    const { dialog, start, end } = await openForm()
    await setDate(start, '2026-10-26')
    await setDate(end, '2026-10-30')
    await advance(DEBOUNCE)
    expect(dialog.textContent).toContain('5 calendar days')
    expect(dialog.textContent).toContain('Holiday is charged in working days. They are counted when you submit.')
    expect(dialog.textContent).toContain('2 remaining')
    expect(dialog.textContent).not.toContain('exceeds balance')
    expect(dialog.textContent).not.toContain('requested')
  })

  it('asks nothing for an inverted range, and shows no line', async () => {
    const previews = mockFetch({ onPreview: () => json(previewBody(1)) })
    const { dialog, start, end } = await openForm()
    await setDate(start, '2026-10-30')
    await setDate(end, '2026-10-26')
    await advance(DEBOUNCE * 2)
    expect(previews).toHaveLength(0)
    expect(dialog.textContent).not.toMatch(/requested|calendar day|Counting/)
  })

  it('re-asks when the type changes (only a holiday is charged in working days)', async () => {
    const previews = mockFetch({ onPreview: () => json(previewBody(4)) })
    const { dialog, start, end } = await openForm()
    await setDate(start, '2026-10-26')
    await setDate(end, '2026-10-30')
    await advance(DEBOUNCE)
    await act(async () => {
      fireEvent.click(Array.from(dialog.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent.trim() === 'Sick'))
    })
    expect(dialog.textContent).toContain('Counting days...')
    await advance(DEBOUNCE)
    expect(previews).toHaveLength(2)
    expect(previews[1].url).toContain('type=sick')
    expect(dialog.textContent).not.toContain('remaining')
  })

  it('on behalf of a colleague: the server\'s number, no balance, no profile in the query, and never the manager\'s own clashes', async () => {
    const previews = mockFetch({ remaining: 1, staff: STAFF, onPreview: () => json(previewBody(4)) })
    const { dialog, start, end } = await openForm(APPROVER, { canApprove: true })
    await act(async () => { fireEvent.change(screen.getByLabelText('For'), { target: { value: 'f1' } }) })
    await setDate(start, '2026-10-26')
    await setDate(end, '2026-10-30')
    await advance(DEBOUNCE)
    expect(previews).toHaveLength(1)
    expect(previews[0].url).not.toContain('profile_id')
    expect(previews[0].url).toContain('location_id=loc1')
    expect(dialog.textContent).toContain('4 days requested')
    expect(dialog.textContent).not.toContain('remaining')
    expect(dialog.textContent).not.toContain('exceeds balance')
    expect(document.body.textContent).not.toContain('Opening shift')
  })

  it('shows nobody\'s clashes for an own request either (this form ignores the preview\'s clashes)', async () => {
    mockFetch({ onPreview: () => json(previewBody(4)) })
    const { start } = await openForm()
    await setDate(start, '2026-10-27')
    await advance(DEBOUNCE)
    expect(document.body.textContent).not.toContain('Opening shift')
  })

  it('submits exactly what it always did: the preview changes nothing in the POST', async () => {
    const posted = []
    mockFetch({ posted, onPreview: () => json(previewBody(4)) })
    const { start, end } = await openForm()
    await setDate(start, '2026-10-26')
    await setDate(end, '2026-10-30')
    await advance(DEBOUNCE)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit Request' })) })
    await advance(0)
    expect(posted).toEqual([{ type: 'holiday', start_date: '2026-10-26', end_date: '2026-10-30', reason: null, location_id: 'loc1' }])
  })

  it('a preview still in flight when the form closes is dropped quietly', async () => {
    const previews = mockFetch({ onPreview: () => later(500, previewBody(4)) })
    const { start } = await openForm()
    await setDate(start, '2026-10-26')
    await advance(DEBOUNCE)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit Request' })) })
    await advance(0)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(previews[0].signal.aborted).toBe(true)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await advance(500)
    expect(errors).not.toHaveBeenCalled()
  })
})
