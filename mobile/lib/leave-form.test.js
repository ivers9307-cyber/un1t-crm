// LEAVEPHONE.1 — the leave form's decisions. No RN runtime: the screen renders
// what these return. Note what is NOT here: any counting of days.
import { describe, it, expect } from 'vitest'
import {
  leavePreviewFrom, leaveDaysLabel, leaveDaysHint, pendingHolidayDays, leaveBalanceView, leaveBalanceLines,
  leaveClashSummary, submittedDays, leaveSubmittedMessage, leaveFloatingButtons,
  leaveRequestEntry, leaveFormGate,
} from './leave-form'

const ALLOWANCE = { year: 2026, total_days: 20, used_days: 6, carried_over: 1, remaining: 15, not_applicable: false }
const DAYS_4 = { total: 4, segments: [{ year: 2026, start_date: '2026-06-01', end_date: '2026-06-07', days: 4 }] }
const UNKNOWN = { known: false, days: null, clashes: [] }

describe('leavePreviewFrom', () => {
  it('reads the server\'s days and clashes', () => {
    const clashes = [{ id: 'a1', block_date: '2026-06-02' }]
    expect(leavePreviewFrom({ success: true, data: { type: 'holiday', days: DAYS_4, clashes } }))
      .toEqual({ known: true, days: DAYS_4, clashes })
  })
  it('an ARRAY is an older deployment answering with the request list — unknown, never "0 days / no clashes"', () => {
    expect(leavePreviewFrom({ success: true, data: [{ id: 'req-1' }] })).toEqual(UNKNOWN)
    expect(leavePreviewFrom({ success: true, data: [] })).toEqual(UNKNOWN)
  })
  it('a failure, a transport envelope, a missing body or a malformed days block is unknown too', () => {
    expect(leavePreviewFrom({ success: false, error: 'x' })).toEqual(UNKNOWN)
    expect(leavePreviewFrom({ success: false, transport: true, error: 'Network error' })).toEqual(UNKNOWN)
    expect(leavePreviewFrom(undefined)).toEqual(UNKNOWN)
    expect(leavePreviewFrom({ success: true, data: { days: { total: 'four' }, clashes: [] } })).toEqual(UNKNOWN)
    expect(leavePreviewFrom({ success: true, data: { days: { total: 4 }, clashes: [] } })).toEqual(UNKNOWN)
    expect(leavePreviewFrom({ success: true, data: { days: DAYS_4 } })).toEqual(UNKNOWN)
  })
  it('each unknown is a fresh object (a caller mutating one cannot poison the next)', () => {
    const a = leavePreviewFrom(undefined)
    a.clashes.push('x')
    expect(leavePreviewFrom(undefined).clashes).toEqual([])
  })
})

describe('leaveDaysLabel', () => {
  it('says it is waiting, rather than guessing, until the server answers', () => {
    expect(leaveDaysLabel({ loading: true, preview: UNKNOWN })).toBe('Counting days…')
  })
  it('shows the server\'s number', () => {
    expect(leaveDaysLabel({ loading: false, preview: { known: true, days: DAYS_4 } })).toBe('This request uses 4 days')
    expect(leaveDaysLabel({ loading: false, preview: { known: true, days: { total: 1, segments: [] } } })).toBe('This request uses 1 day')
    expect(leaveDaysLabel({ loading: false, preview: { known: true, days: { total: 0, segments: [] } } })).toBe('No working days in that range')
  })
  it('when the server could not say, it says so — it never shows a locally computed number', () => {
    expect(leaveDaysLabel({ loading: false, preview: UNKNOWN })).toBe('Days are counted when you submit')
    expect(leaveDaysLabel({ loading: false, preview: undefined })).toBe('Days are counted when you submit')
  })
})

describe('leaveDaysHint', () => {
  it('explains the working-day rule for holiday only', () => {
    expect(leaveDaysHint('holiday')).toMatch(/bank holidays/)
    for (const t of ['sick', 'unpaid', 'other', 'unavailable']) expect(leaveDaysHint(t)).toBeNull()
  })
})

describe('pendingHolidayDays', () => {
  it('sums RAW-pending holiday requests that START in the year — expired ones included, as the server does', () => {
    const rows = [
      { type: 'holiday', status: 'pending', start_date: '2026-11-02', total_days: 3 },
      { type: 'holiday', status: 'pending', effective_status: 'expired', start_date: '2026-03-02', total_days: 2 },
      { type: 'holiday', status: 'approved', start_date: '2026-07-06', total_days: 5 },
      { type: 'sick', status: 'pending', start_date: '2026-11-09', total_days: 1 },
      { type: 'holiday', status: 'pending', start_date: '2027-01-04', total_days: 4 },
    ]
    expect(pendingHolidayDays(rows, 2026)).toBe(5)
    expect(pendingHolidayDays(null, 2026)).toBe(0)
  })
  it('counts only the named profile\'s rows when one is given (a manager\'s list can hold others\')', () => {
    const rows = [
      { profile_id: 'me', type: 'holiday', status: 'pending', start_date: '2026-11-02', total_days: 3 },
      { profile_id: 'other', type: 'holiday', status: 'pending', start_date: '2026-11-02', total_days: 9 },
    ]
    expect(pendingHolidayDays(rows, 2026, 'me')).toBe(3)
  })
})

describe('leaveBalanceView', () => {
  const base = { employmentType: 'fte', allowance: ALLOWANCE, requests: [], type: 'holiday', days: DAYS_4 }

  it('hidden for contractors and casual staff, for a not-applicable allowance, and until the allowance has loaded', () => {
    expect(leaveBalanceView({ ...base, employmentType: 'contractor' })).toBeNull()
    expect(leaveBalanceView({ ...base, employmentType: 'casual' })).toBeNull()
    expect(leaveBalanceView({ ...base, allowance: { ...ALLOWANCE, not_applicable: true } })).toBeNull()
    expect(leaveBalanceView({ ...base, allowance: null })).toBeNull()
  })

  it('hidden when the allowance is not a usable number — never "NaN days available"', () => {
    expect(leaveBalanceView({ ...base, allowance: { year: 2026 } })).toBeNull()
  })

  it('hidden when the allowance on screen is for a different year than the leave starts in', () => {
    expect(leaveBalanceView({ ...base, year: 2027 })).toBeNull()
    expect(leaveBalanceView({ ...base, year: 2026 })).not.toBeNull()
  })

  // The allowance loaded but the coach's own request list did NOT: pending is
  // unknown, and "remaining" alone overstates what the POST will judge
  // (3 remaining - 3 pending reads "3 days available", then the POST 400s).
  it('hidden when the requests read failed — an unknown pending sum is never shown as 0', () => {
    expect(leaveBalanceView({ ...base, requestsKnown: false })).toBeNull()
    expect(leaveBalanceView({ ...base, requestsKnown: false, allowance: { ...ALLOWANCE, remaining: 3 }, requests: [] })).toBeNull()
    expect(leaveBalanceView({ ...base, requestsKnown: true })).not.toBeNull()
  })

  it('available = remaining minus pending; a holiday request shows what is left after it', () => {
    const requests = [{ type: 'holiday', status: 'pending', start_date: '2026-11-02', total_days: 3 }]
    expect(leaveBalanceView({ ...base, requests })).toEqual({
      year: 2026, total: 20, used: 6, carriedOver: 1, pending: 3, available: 12,
      requestDays: 4, after: 8, short: false, otherYearDays: 0,
    })
  })

  it('short when the server\'s count is bigger than what is available', () => {
    expect(leaveBalanceView({ ...base, allowance: { ...ALLOWANCE, remaining: 3 } }))
      .toMatchObject({ available: 3, requestDays: 4, after: -1, short: true })
  })

  it('a non-holiday type never touches the balance', () => {
    expect(leaveBalanceView({ ...base, type: 'sick', days: { total: 7, segments: [{ year: 2026, days: 7 }] } }))
      .toMatchObject({ available: 15, requestDays: 0, after: 15, short: false, otherYearDays: 0 })
  })

  it('across a year end only the allowance year\'s segment is charged here; the rest is reported', () => {
    const days = { total: 3, segments: [{ year: 2026, days: 2 }, { year: 2027, days: 1 }] }
    expect(leaveBalanceView({ ...base, days })).toMatchObject({ year: 2026, requestDays: 2, otherYearDays: 1, after: 13 })
  })

  it('until the server has counted, the balance shows with no "after" — never a guess', () => {
    expect(leaveBalanceView({ ...base, days: null })).toMatchObject({ available: 15, requestDays: null, after: null, short: false, otherYearDays: 0 })
  })
})

describe('leaveBalanceLines — the card\'s words', () => {
  const view = { year: 2026, total: 20, used: 6, carriedOver: 1, pending: 3, available: 12, requestDays: 4, after: 8, short: false, otherYearDays: 0 }
  it('null view is no card', () => {
    expect(leaveBalanceLines(null, 'holiday')).toBeNull()
  })
  it('heading, available, breakdown and what is left after a holiday request', () => {
    expect(leaveBalanceLines(view, 'holiday')).toEqual({
      short: false,
      heading: 'Holiday balance 2026',
      available: '12 days available',
      breakdown: '20 allowance + 1 carried over · 6 used · 3 pending',
      request: '8 days left after this request.',
      otherYear: null,
    })
  })
  it('singulars, and the zero parts of the breakdown are left out', () => {
    expect(leaveBalanceLines({ ...view, carriedOver: 0, pending: 0, available: 1, after: 1, requestDays: 1 }, 'holiday')).toMatchObject({
      available: '1 day available', breakdown: '20 allowance · 6 used', request: '1 day left after this request.',
    })
  })
  it('short says what it needs and what there is', () => {
    expect(leaveBalanceLines({ ...view, available: 3, after: -1, short: true }, 'holiday')).toMatchObject({
      short: true, request: 'This request needs 4 days. You have 3.',
    })
  })
  it('no request line for another leave type, or until the server has counted', () => {
    expect(leaveBalanceLines({ ...view, requestDays: 0, after: 12 }, 'sick').request).toBeNull()
    expect(leaveBalanceLines({ ...view, requestDays: null, after: null }, 'holiday').request).toBeNull()
  })
  it('days in the next year are named against that year', () => {
    expect(leaveBalanceLines({ ...view, otherYearDays: 1 }, 'holiday').otherYear)
      .toBe('1 of these days falls in 2027 and counts against that year’s allowance. That balance is checked when you submit.')
    expect(leaveBalanceLines({ ...view, otherYearDays: 2 }, 'holiday').otherYear)
      .toBe('2 of these days fall in 2027 and count against that year’s allowance. That balance is checked when you submit.')
  })
})

describe('leaveClashSummary', () => {
  const clash = (i) => ({ id: `a${i}`, block_date: '2026-10-05', start_time: '06:00:00', end_time: '09:00:00', template_name: 'Morning', location_name: 'Studio One' })
  it('null unless the preview is KNOWN and has clashes: unknown must not read as "none"', () => {
    expect(leaveClashSummary(UNKNOWN)).toBeNull()
    expect(leaveClashSummary({ known: true, days: DAYS_4, clashes: [] })).toBeNull()
    expect(leaveClashSummary({ known: false, days: null, clashes: [clash(1)] })).toBeNull()
  })
  it('heading, one keyed line per shift, and the cover line', () => {
    expect(leaveClashSummary({ known: true, days: DAYS_4, clashes: [clash(1)] })).toEqual({
      count: 1,
      heading: 'You are rostered on 1 shift in these dates',
      lines: [{ id: 'a1', text: 'Mon 5 Oct · 06:00–09:00 · Morning · Studio One' }],
      more: null,
      footer: 'A manager will need to cover these.',
    })
  })
  it('caps the list at 8 and says how many more', () => {
    const s = leaveClashSummary({ known: true, days: DAYS_4, clashes: Array.from({ length: 11 }, (_, i) => clash(i)) })
    expect(s.heading).toBe('You are rostered on 11 shifts in these dates')
    expect(s.lines).toHaveLength(8)
    expect(s.more).toBe('and 3 more')
  })
  it('a clash row with no id still gets a unique list key', () => {
    const s = leaveClashSummary({ known: true, days: DAYS_4, clashes: [{ block_date: '2026-10-05' }, { block_date: '2026-10-06' }] })
    expect(new Set(s.lines.map((l) => l.id)).size).toBe(2)
  })
})

describe('submittedDays / leaveSubmittedMessage', () => {
  it('the charged days come from the POST response, every year segment included', () => {
    expect(submittedDays({ success: true, data: { total_days: 2 }, data_all: [{ total_days: 2 }, { total_days: 1 }] })).toBe(3)
    expect(submittedDays({ success: true, data: { total_days: 4 } })).toBe(4)
    expect(submittedDays({ success: true, data: {} })).toBeNull()
    expect(submittedDays(undefined)).toBeNull()
  })
  it('names the type, the range and the days, and says what happens next', () => {
    expect(leaveSubmittedMessage({ type: 'holiday', startIso: '2026-06-01', endIso: '2026-06-07', days: 4, clashCount: 0 })).toEqual({
      title: 'Request sent',
      message: 'Holiday · Mon 1 Jun – Sun 7 Jun · 4 days.\nYour manager has been notified. Track it under My leave.',
    })
  })
  it('one day is singular; unknown days are left out; clashes get the cover line', () => {
    expect(leaveSubmittedMessage({ type: 'unavailable', startIso: '2026-10-05', endIso: '2026-10-05', days: 1, clashCount: 2 }).message)
      .toBe('Unavailable · Mon 5 Oct · 1 day.\nYour manager has been notified. Track it under My leave.\nYou are still rostered on 2 shifts in that time. A manager will need to cover these.')
    expect(leaveSubmittedMessage({ type: 'sick', startIso: '2026-10-05', endIso: '2026-10-05', days: null, clashCount: 0 }).message)
      .toBe('Sick · Mon 5 Oct.\nYour manager has been notified. Track it under My leave.')
  })
})

describe('leaveFloatingButtons — do "My leave" and "Request time off" fit side by side?', () => {
  it('a 390pt phone at the default text size keeps the full label', () => {
    expect(leaveFloatingButtons({ width: 390, fontScale: 1 })).toEqual({
      compact: false, requestLabel: 'Request time off', myLeaveLabel: 'My leave',
      requestA11y: 'Request time off', myLeaveA11y: 'My leave, your time-off requests',
      requestIcon: 'add', requestTarget: '/schedule/time-off-new',
    })
  })
  it('AVAIL.3 — a contractor\'s request button opens My availability, full and compact', () => {
    expect(leaveFloatingButtons({ width: 390, fontScale: 1, employmentType: 'contractor' })).toMatchObject({
      compact: false, requestLabel: 'My availability', requestA11y: 'My availability, when you can’t work',
      requestIcon: 'time-outline', requestTarget: '/schedule/availability', myLeaveLabel: 'My leave',
    })
    expect(leaveFloatingButtons({ width: 320, fontScale: 1, employmentType: 'casual' }))
      .toMatchObject({ compact: true, requestLabel: 'Availability', requestTarget: '/schedule/availability' })
  })
  it('a 360pt phone, or larger text on a 390pt one, shortens the visible label only', () => {
    for (const dims of [{ width: 360, fontScale: 1 }, { width: 390, fontScale: 1.3 }, { width: 320, fontScale: 1 }]) {
      const b = leaveFloatingButtons(dims)
      expect(b).toMatchObject({ compact: true, requestLabel: 'Time off', myLeaveLabel: 'My leave' })
      // A screen reader always hears the full name.
      expect(b.requestA11y).toBe('Request time off')
    }
  })
  it('unknown dimensions take the safe, short label', () => {
    expect(leaveFloatingButtons({}).compact).toBe(true)
    expect(leaveFloatingButtons(undefined).compact).toBe(true)
    expect(leaveFloatingButtons({ width: 390 }).compact).toBe(false)   // fontScale defaults to 1
  })
  it('a wide screen keeps the full label even with larger text', () => {
    expect(leaveFloatingButtons({ width: 768, fontScale: 1.5 }).compact).toBe(false)
  })
})

// AVAIL.3 — "unavailable" moved into availability: a contractor has nothing to
// request, so every entry that said "Request time off" opens My availability.
describe('leaveRequestEntry', () => {
  it('an employee (or unknown employment) requests time off', () => {
    for (const et of ['fte', null, undefined]) {
      expect(leaveRequestEntry(et)).toEqual({
        target: '/schedule/time-off-new', label: 'Request time off', shortLabel: 'Time off',
        a11y: 'Request time off', icon: 'add', rowIcon: 'calendar-outline',
      })
    }
  })
  it('a contractor or casual staff member is sent to My availability', () => {
    for (const et of ['contractor', 'casual']) {
      expect(leaveRequestEntry(et)).toEqual({
        target: '/schedule/availability', label: 'My availability', shortLabel: 'Availability',
        a11y: 'My availability, when you can’t work', icon: 'time-outline', rowIcon: 'time-outline',
      })
    }
  })
})

describe('leaveFormGate', () => {
  it('no gate for anyone with something to request', () => {
    expect(leaveFormGate('fte')).toBeNull()
    expect(leaveFormGate(undefined)).toBeNull() // profile still loading: never a false gate
  })
  it('a contractor reaching the form (old link, notification) is told where to go', () => {
    expect(leaveFormGate('contractor')).toEqual({
      title: 'Use My availability instead',
      message: expect.stringMatching(/My availability/),
      action: 'Open My availability',
      target: '/schedule/availability',
    })
  })
})
