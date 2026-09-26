// TIMEOFFREPORT.1 — the Time Off Summary asked for requests CONTAINED in the
// period (start >= period start AND end <= period end), so leave spanning a
// month end fell out of BOTH months' reports, and a failed read saved an empty
// report. It now reads every request that OVERLAPS the period and counts each
// for the days inside it; a failed read fails the report. roster_coverage's
// time-off read gets the same error handling.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/time-off-leave', () => ({ getNonWorkingDates: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getNonWorkingDates } from '@/lib/time-off-leave'
import { generateReport, fetchOverlappingTimeOff, timeOffDaysInPeriod } from './report-generator'

// A builder that APPLIES the date filters the code asks for, so a containment
// filter (the old bug) and an overlap filter give different answers.
function makeDb({ timeOff = [], timeOffError = null, pageSize = null } = {}) {
  const captured = { inserted: null, timeOffCalls: [] }
  const from = vi.fn((table) => {
    const filters = []
    let range = null
    const b = {
      select: () => b,
      eq: (col, v) => { filters.push((r) => col === 'location_id' || r[col] === v); return b },
      lte: (col, v) => { filters.push((r) => r[col] <= v); return b },
      gte: (col, v) => { filters.push((r) => r[col] >= v); return b },
      order: () => b,
      range: (a, z) => { range = [a, z]; return b },
      in: () => b,
      insert: (rec) => { captured.inserted = rec; return b },
      single: () => Promise.resolve({ data: { id: 'gen-1', ...captured.inserted }, error: null }),
      then: (ok, err) => {
        if (table === 'time_off_requests') {
          captured.timeOffCalls.push(range)
          if (timeOffError) return Promise.resolve({ data: null, error: timeOffError }).then(ok, err)
          let rows = timeOff.filter((r) => filters.every((f) => f(r)))
          if (range && pageSize) rows = rows.slice(range[0], range[0] + pageSize)
          return Promise.resolve({ data: rows, error: null }).then(ok, err)
        }
        return Promise.resolve({ data: [], error: null }).then(ok, err)
      },
    }
    return b
  })
  return { db: { from }, captured }
}

function req(id, start, end, { type = 'sick', status = 'approved', total = null, name = 'Coach A' } = {}) {
  return { id, location_id: 'loc1', profile_id: `p-${name}`, type, status, start_date: start, end_date: end, total_days: total, profiles: { full_name: name, role: 'staff' } }
}

const SEPT = { period_start: '2026-09-01', period_end: '2026-09-30', location_id: 'loc1' }

beforeEach(() => { vi.clearAllMocks() })

describe('timeOffDaysInPeriod (pure)', () => {
  it('a request wholly inside keeps its stored total_days, half days included', () => {
    expect(timeOffDaysInPeriod({ type: 'holiday', start_date: '2026-09-10', end_date: '2026-09-10', total_days: 0.5 }, '2026-09-01', '2026-09-30'))
      .toEqual({ days: 0.5, crosses: false })
  })

  it('a calendar-day type crossing the end is counted for the days inside only', () => {
    expect(timeOffDaysInPeriod({ type: 'sick', start_date: '2026-09-28', end_date: '2026-10-03', total_days: 6 }, '2026-09-01', '2026-09-30'))
      .toEqual({ days: 3, crosses: true })
  })

  it('a holiday crossing the start counts working days inside, minus non-working dates', () => {
    // Thu 27 Aug → Fri 4 Sep; inside September: Tue 1 – Fri 4 = 4 weekdays, minus a closure on Wed 2.
    expect(timeOffDaysInPeriod({ type: 'holiday', start_date: '2026-08-27', end_date: '2026-09-04', total_days: 7 }, '2026-09-01', '2026-09-30', new Set(['2026-09-02'])))
      .toEqual({ days: 3, crosses: true })
  })

  it('a request longer than the period on both sides is clipped to the whole period', () => {
    expect(timeOffDaysInPeriod({ type: 'unpaid', start_date: '2026-08-15', end_date: '2026-10-15', total_days: 62 }, '2026-09-01', '2026-09-30'))
      .toEqual({ days: 30, crosses: true })
  })
})

describe('fetchOverlappingTimeOff', () => {
  it('pages past 1,000 rows', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => req(`r${i}`, '2026-09-05', '2026-09-05', { total: 1 }))
    const { db, captured } = makeDb({ timeOff: many, pageSize: 1000 })
    const { rows, error } = await fetchOverlappingTimeOff(db, { locationId: 'loc1', periodStart: '2026-09-01', periodEnd: '2026-09-30', select: '*' })
    expect(error).toBeNull()
    expect(rows).toHaveLength(1500)
    expect(captured.timeOffCalls).toEqual([[0, 999], [1000, 1999]])
  })

  it('a failed read is an error, never an empty list', async () => {
    const { db } = makeDb({ timeOffError: { message: 'boom' } })
    expect(await fetchOverlappingTimeOff(db, { locationId: 'loc1', periodStart: '2026-09-01', periodEnd: '2026-09-30', select: '*' }))
      .toEqual({ rows: [], error: 'boom' })
  })
})

describe('generateReport — time_off_summary', () => {
  it('includes leave that crosses either edge of the period, counted for its days inside', async () => {
    const { db, captured } = makeDb({ timeOff: [
      req('inside', '2026-09-10', '2026-09-11', { total: 2, name: 'Coach A' }),
      req('over-end', '2026-09-28', '2026-10-03', { total: 6, name: 'Coach B' }),
      req('over-start', '2026-08-30', '2026-09-02', { total: 4, name: 'Coach C' }),
      req('august', '2026-08-01', '2026-08-05', { total: 5, name: 'Coach D' }),
      req('october', '2026-10-05', '2026-10-06', { total: 2, name: 'Coach E' }),
    ] })
    createServerClient.mockReturnValue(db)

    const res = await generateReport({ report_type: 'time_off_summary', ...SEPT })
    expect(res.success).toBe(true)
    const data = captured.inserted.report_data
    expect(data.requests.map((r) => r.id).sort()).toEqual(['inside', 'over-end', 'over-start'])
    expect(Object.fromEntries(data.requests.map((r) => [r.id, [r.days_in_period, r.crosses_period]]))).toEqual({
      inside: [2, false], 'over-end': [3, true], 'over-start': [2, true],
    })
    expect(data.by_type.sick).toBe(7)
    expect(data.by_staff['Coach B'].total).toBe(3)
    expect(captured.inserted.summary.total_days).toBe(7)
    expect(captured.inserted.summary.total_requests).toBe(3)
    // No holiday crossed an edge, so the studio's holiday list was not read.
    expect(getNonWorkingDates).not.toHaveBeenCalled()
  })

  it('a month-end request is split between the two months, never counted twice', async () => {
    const both = [req('span', '2026-09-28', '2026-10-03', { total: 6 })]
    const sept = makeDb({ timeOff: both }); createServerClient.mockReturnValue(sept.db)
    await generateReport({ report_type: 'time_off_summary', ...SEPT })
    const oct = makeDb({ timeOff: both }); createServerClient.mockReturnValue(oct.db)
    await generateReport({ report_type: 'time_off_summary', period_start: '2026-10-01', period_end: '2026-10-31', location_id: 'loc1' })
    expect(sept.captured.inserted.summary.total_days + oct.captured.inserted.summary.total_days).toBe(6)
  })

  it('a holiday crossing an edge is recounted against the studio holidays', async () => {
    getNonWorkingDates.mockResolvedValueOnce({ dates: new Set(['2026-09-02']), error: null })
    const { db, captured } = makeDb({ timeOff: [req('hol', '2026-08-27', '2026-09-04', { type: 'holiday', total: 6 })] })
    createServerClient.mockReturnValue(db)
    const res = await generateReport({ report_type: 'time_off_summary', ...SEPT })
    expect(res.success).toBe(true)
    expect(getNonWorkingDates).toHaveBeenCalledWith(db, 'loc1', '2026-09-01', '2026-09-30', { quiet: true })
    expect(captured.inserted.report_data.by_type.holiday).toBe(3)
  })

  it('an unreadable holiday list fails the report rather than over-count', async () => {
    getNonWorkingDates.mockResolvedValueOnce({ dates: null, error: { message: 'holidays down' } })
    const { db, captured } = makeDb({ timeOff: [req('hol', '2026-08-27', '2026-09-04', { type: 'holiday', total: 6 })] })
    createServerClient.mockReturnValue(db)
    expect(await generateReport({ report_type: 'time_off_summary', ...SEPT })).toEqual({ success: false, error: 'holidays down' })
    expect(captured.inserted).toBeNull()
  })

  it('a failed time-off read fails the report and saves nothing (it used to save an empty one)', async () => {
    const { db, captured } = makeDb({ timeOffError: { message: 'read failed' } })
    createServerClient.mockReturnValue(db)
    expect(await generateReport({ report_type: 'time_off_summary', ...SEPT })).toEqual({ success: false, error: 'read failed' })
    expect(captured.inserted).toBeNull()
  })
})

describe('generateReport — roster_coverage time off', () => {
  it('a failed time-off read fails the report instead of showing nobody off', async () => {
    const { db, captured } = makeDb({ timeOffError: { message: 'read failed' } })
    createServerClient.mockReturnValue(db)
    expect(await generateReport({ report_type: 'roster_coverage', ...SEPT })).toEqual({ success: false, error: 'read failed' })
    expect(captured.inserted).toBeNull()
  })

  it('still marks approved leave that crosses the period edge on the days inside', async () => {
    const { db, captured } = makeDb({ timeOff: [req('span', '2026-09-29', '2026-10-02', { total: 4, name: 'Coach B' })] })
    createServerClient.mockReturnValue(db)
    const res = await generateReport({ report_type: 'roster_coverage', ...SEPT })
    expect(res.success).toBe(true)
    const off = captured.inserted.report_data.days.filter((d) => d.staff_off.includes('Coach B')).map((d) => d.date)
    expect(off).toEqual(['2026-09-29', '2026-09-30'])
  })
})
