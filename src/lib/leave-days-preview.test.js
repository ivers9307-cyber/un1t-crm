// LEAVEDAYS.1 — every decision the web leave form's "days requested" line
// makes. The component test (TimeOffManager.days.test.jsx) only proves the
// wiring: debounce, last request wins, and that these are what it renders.

import { describe, it, expect } from 'vitest'
import {
  LEAVE_PREVIEW_DEBOUNCE_MS, leavePreviewRequest, leavePreviewFrom, leavePreviewState, leaveDaysView,
} from './leave-days-preview'

const days = (total, segments) => ({ total, segments })
const seg = (year, n) => ({ year, start_date: `${year}-01-01`, end_date: `${year}-01-02`, days: n })
const ok = (d) => ({ status: 'ok', days: d })
const ALLOWANCE = { year: 2026, total_days: 20, used_days: 4, carried_over: 0, remaining: 16 }
const OWN_HOLIDAY = { type: 'holiday', onBehalf: false, allowance: ALLOWANCE, startDate: '2026-10-26', endDate: '2026-10-30' }

describe('leavePreviewRequest — what is worth asking the server', () => {
  it('builds the preview URL for a complete range, with the studio the POST files at', () => {
    const req = leavePreviewRequest({ type: 'holiday', startDate: '2026-10-26', endDate: '2026-10-30', locationId: 'loc1' })
    expect(req.url).toBe('/api/schedule/time-off?preview=1&type=holiday&start_date=2026-10-26&end_date=2026-10-30&location_id=loc1')
    expect(req.key).toBe('holiday|2026-10-26|2026-10-30|loc1')
  })

  it('omits location_id when the form has none, so the server applies the POST\'s own active-studio fallback', () => {
    const req = leavePreviewRequest({ type: 'sick', startDate: '2026-10-26', endDate: '2026-10-26', locationId: undefined })
    expect(req.url).not.toContain('location_id')
  })

  it('a different type, date or studio is a different key', () => {
    const base = { type: 'holiday', startDate: '2026-10-26', endDate: '2026-10-30', locationId: 'loc1' }
    const keys = new Set([
      leavePreviewRequest(base).key,
      leavePreviewRequest({ ...base, type: 'sick' }).key,
      leavePreviewRequest({ ...base, endDate: '2026-10-31' }).key,
      leavePreviewRequest({ ...base, locationId: 'loc2' }).key,
    ])
    expect(keys.size).toBe(4)
  })

  it.each([
    ['no start', { startDate: '', endDate: '2026-10-30' }],
    ['no end', { startDate: '2026-10-26', endDate: '' }],
    ['inverted', { startDate: '2026-10-30', endDate: '2026-10-26' }],
    ['a half-typed date', { startDate: '2026-10-2', endDate: '2026-10-30' }],
    ['no type', { type: '' }],
  ])('asks nothing for %s', (_, patch) => {
    expect(leavePreviewRequest({ type: 'holiday', startDate: '2026-10-26', endDate: '2026-10-30', locationId: 'loc1', ...patch })).toBeNull()
  })
})

describe('leavePreviewFrom — recognising a deployment that has the preview', () => {
  it('reads days from the preview object', () => {
    const d = days(4, [seg(2026, 4)])
    expect(leavePreviewFrom({ success: true, data: { days: d, clashes: [{ id: 'a1' }] } })).toEqual({ known: true, days: d })
  })

  it('never carries clashes: they are the CALLER\'s shifts, wrong for an on-behalf request', () => {
    const out = leavePreviewFrom({ success: true, data: { days: days(1, [seg(2026, 1)]), clashes: [{ id: 'a1' }] } })
    expect(out).not.toHaveProperty('clashes')
  })

  it.each([
    ['the request LIST (an old server ignores preview=1)', { success: true, data: [{ id: 'r1' }] }],
    ['a failure', { success: false, error: 'boom' }],
    ['nothing', null],
    ['no total', { success: true, data: { days: { segments: [] } } }],
    ['no segments', { success: true, data: { days: { total: 3 } } }],
  ])('%s is unknown, never 0 days', (_, res) => {
    expect(leavePreviewFrom(res)).toEqual({ known: false, days: null })
  })
})

describe('leavePreviewState — a result only counts for the inputs it was asked for', () => {
  const request = { key: 'holiday|2026-10-26|2026-10-30|loc1', url: '/x' }
  it('idle with nothing to ask', () => {
    expect(leavePreviewState(null, { key: request.key, known: true, days: days(4, []) })).toEqual({ status: 'idle', days: null })
  })
  it('loading until a result for THIS key lands, even while an older result is still in state', () => {
    expect(leavePreviewState(request, null).status).toBe('loading')
    expect(leavePreviewState(request, { key: 'holiday|2026-10-26|2026-10-29|loc1', known: true, days: days(3, []) }).status).toBe('loading')
  })
  it('ok / unknown once it does', () => {
    const d = days(4, [seg(2026, 4)])
    expect(leavePreviewState(request, { key: request.key, known: true, days: d })).toEqual({ status: 'ok', days: d })
    expect(leavePreviewState(request, { key: request.key, known: false, days: null })).toEqual({ status: 'unknown', days: null })
  })
})

describe('leaveDaysView — the line under the dates', () => {
  it('nothing without a range, and nothing for a range that is not worth asking about', () => {
    expect(leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 0, preview: { status: 'idle' } })).toBeNull()
    expect(leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 1, preview: { status: 'idle' } })).toBeNull()
  })

  it('while loading: says it is counting, shows no number and judges nothing', () => {
    expect(leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 5, preview: { status: 'loading' } }))
      .toEqual({ text: 'Counting days...', balance: null, exceeds: false, hint: null, note: null })
  })

  it('THE DEFECT: a bank-holiday week shows the server\'s 4, not the calendar\'s 5, and is judged on 4', () => {
    const view = leaveDaysView({
      ...OWN_HOLIDAY, calendarDays: 5, allowance: { ...ALLOWANCE, remaining: 4 }, preview: ok(days(4, [seg(2026, 4)])),
    })
    expect(view.text).toBe('4 days requested')
    expect(view.balance).toBe('4 remaining')
    expect(view.exceeds).toBe(false)
    expect(view.hint).toBe('Weekends, bank holidays and days the studio is closed are not charged.')
  })

  it('exceeds balance only when the SERVER\'s number does', () => {
    const view = leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 5, allowance: { ...ALLOWANCE, remaining: 3 }, preview: ok(days(4, [seg(2026, 4)])) })
    expect(view.exceeds).toBe(true)
  })

  it('singular, and no hint when nothing was taken off', () => {
    const view = leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 1, preview: ok(days(1, [seg(2026, 1)])) })
    expect(view.text).toBe('1 day requested')
    expect(view.hint).toBeNull()
  })

  it('a range the server prices at 0 says so plainly, with no balance line', () => {
    const view = leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 2, preview: ok(days(0, [seg(2026, 0)])) })
    expect(view.text).toBe('No working days in that range')
    expect(view.balance).toBeNull()
    expect(view.exceeds).toBe(false)
    expect(view.hint).toBe('Weekends, bank holidays and days the studio is closed are not charged.')
  })

  it.each([
    ['another type', { type: 'sick' }],
    ['an on-behalf request (the allowance on screen is the MANAGER\'s)', { onBehalf: true }],
    ['a contractor', { allowance: { ...ALLOWANCE, not_applicable: true } }],
    ['no allowance loaded', { allowance: null }],
  ])('no balance and no judgement for %s', (_, patch) => {
    const view = leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 30, preview: ok(days(22, [seg(2026, 22)])), ...patch })
    expect(view.text).toBe('22 days requested')
    expect(view.balance).toBeNull()
    expect(view.exceeds).toBe(false)
    expect(view.note).toBeNull()
  })

  it('an on-behalf holiday still shows the server\'s number: days depend on the studio and the dates, not the person', () => {
    const view = leaveDaysView({ ...OWN_HOLIDAY, onBehalf: true, calendarDays: 5, preview: ok(days(4, [seg(2026, 4)])) })
    expect(view.text).toBe('4 days requested')
  })

  describe('a range across two leave years', () => {
    const across = ok(days(6, [seg(2026, 2), seg(2027, 4)]))
    const range = { startDate: '2026-12-30', endDate: '2027-01-07' }

    it('judges only the days in the allowance\'s own year, and says where the rest go', () => {
      const view = leaveDaysView({ ...OWN_HOLIDAY, ...range, calendarDays: 9, allowance: { ...ALLOWANCE, remaining: 3 }, preview: across })
      expect(view.text).toBe('6 days requested')
      expect(view.balance).toBe('3 remaining in 2026')
      expect(view.exceeds).toBe(false) // 2 of 2026's days against 3, not all 6
      expect(view.note).toBe('4 of these days fall in 2027 and count against that year\'s allowance. That balance is checked when you submit.')
    })

    it('still exceeds when this year\'s share does', () => {
      const view = leaveDaysView({ ...OWN_HOLIDAY, ...range, calendarDays: 9, allowance: { ...ALLOWANCE, remaining: 1 }, preview: across })
      expect(view.exceeds).toBe(true)
    })

    it('a request wholly in another year shows no balance from this one', () => {
      const view = leaveDaysView({
        ...OWN_HOLIDAY, startDate: '2027-01-04', endDate: '2027-01-04', calendarDays: 1,
        allowance: { ...ALLOWANCE, remaining: 0 }, preview: ok(days(1, [seg(2027, 1)])),
      })
      expect(view.balance).toBeNull()
      expect(view.exceeds).toBe(false)
      expect(view.note).toBe('1 of these days falls in 2027 and counts against that year\'s allowance. That balance is checked when you submit.')
    })

    it('an allowance with no year (older response) keeps the single-year judgement on the total', () => {
      const { year: _year, ...noYear } = ALLOWANCE
      const view = leaveDaysView({ ...OWN_HOLIDAY, ...range, calendarDays: 9, allowance: { ...noYear, remaining: 5 }, preview: across })
      expect(view.balance).toBe('5 remaining')
      expect(view.exceeds).toBe(true)
      expect(view.note).toBeNull()
    })
  })

  describe('when the server\'s number is not available (error, or a deployment without the preview)', () => {
    it('holiday: calendar days, named as such, with NO exceeds judgement however large', () => {
      const view = leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 30, allowance: { ...ALLOWANCE, remaining: 2 }, preview: { status: 'unknown' } })
      expect(view.text).toBe('30 calendar days')
      expect(view.balance).toBe('2 remaining')
      expect(view.exceeds).toBe(false)
      expect(view.hint).toBe('Holiday is charged in working days. They are counted when you submit.')
    })

    it('other types: calendar days, no hint', () => {
      const view = leaveDaysView({ ...OWN_HOLIDAY, type: 'sick', calendarDays: 1, preview: { status: 'unknown' } })
      expect(view).toEqual({ text: '1 calendar day', balance: null, exceeds: false, hint: null, note: null })
    })

    it('no balance from this year for a range wholly in another', () => {
      const view = leaveDaysView({ ...OWN_HOLIDAY, startDate: '2027-01-04', endDate: '2027-01-08', calendarDays: 5, preview: { status: 'unknown' } })
      expect(view.balance).toBeNull()
    })
  })

  it('no em-dashes in any copy', () => {
    const views = [
      leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 5, preview: { status: 'loading' } }),
      leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 5, preview: { status: 'unknown' } }),
      leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 5, preview: ok(days(0, [seg(2026, 0)])) }),
      leaveDaysView({ ...OWN_HOLIDAY, calendarDays: 9, preview: ok(days(6, [seg(2026, 2), seg(2027, 4)])) }),
    ]
    expect(JSON.stringify(views)).not.toMatch(/[–—]/)
  })

  it('the debounce is long enough to swallow a date-picker burst and short enough to feel live', () => {
    expect(LEAVE_PREVIEW_DEBOUNCE_MS).toBeGreaterThanOrEqual(200)
    expect(LEAVE_PREVIEW_DEBOUNCE_MS).toBeLessThanOrEqual(500)
  })
})
