// DATECHECK.1 (review) — the one rule for a report's period, shared by
// POST /api/schedule/reports and generateReport, and the bounded day walk.
import { describe, it, expect } from 'vitest'
import { reportPeriodError, rangeQueryError, eachReportDay, MAX_REPORT_DAYS, MAX_LIST_RANGE_DAYS } from './report-period'

describe('reportPeriodError', () => {
  it('passes a real, ordered period of up to 366 days', () => {
    expect(reportPeriodError('2026-05-04', '2026-05-04')).toBeNull()
    expect(reportPeriodError('2026-01-01', '2027-01-01')).toBeNull() // 366 days
    expect(reportPeriodError('2028-01-01', '2028-12-31')).toBeNull() // a leap year, 366 days
    expect(MAX_REPORT_DAYS).toBe(366)
  })

  it('refuses 367 days', () => {
    expect(reportPeriodError('2026-01-01', '2027-01-02')).toBe('A report can cover at most 366 days')
  })

  it('refuses the top of the calendar (the walk used to spin on it)', () => {
    expect(reportPeriodError('2026-01-01', '9999-12-31')).toBe('A report can cover at most 366 days')
  })

  it('refuses a reversed period', () => {
    expect(reportPeriodError('2026-05-10', '2026-05-04')).toBe('period_end must be on or after period_start')
  })

  it('refuses a date the calendar does not have', () => {
    for (const [s, e] of [['2026-02-30', '2026-03-06'], ['2026-04-01', '2026-04-31'], ['2026-13-01', '2026-13-07'], [undefined, '2026-01-01']]) {
      expect(reportPeriodError(s, e)).toBe('period_start and period_end must be real dates, YYYY-MM-DD')
    }
  })
})

describe('reportPeriodError — named parameters (ATTENDREPORT.1)', () => {
  const names = { startName: 'from', endName: 'to' }
  it('says the names the caller uses', () => {
    expect(reportPeriodError('2026-02-30', '2026-03-06', names)).toBe('from and to must be real dates, YYYY-MM-DD')
    expect(reportPeriodError('2026-05-10', '2026-05-04', names)).toBe('to must be on or after from')
    expect(reportPeriodError('2026-01-01', '2027-01-02', names)).toBe('A report can cover at most 366 days')
    expect(reportPeriodError('2026-01-01', '2027-01-01', names)).toBeNull()
  })
  it('without names, the messages are unchanged', () => {
    expect(reportPeriodError('2026-05-10', '2026-05-04')).toBe('period_end must be on or after period_start')
  })
})

describe('eachReportDay', () => {
  it('walks every calendar day, both ends included, across a month and a DST change', () => {
    expect([...eachReportDay('2026-03-28', '2026-04-01')]).toEqual([
      '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01',
    ])
  })

  it('stops at the end of year 9999 instead of stepping into +010000', () => {
    expect([...eachReportDay('9999-12-30', '9999-12-31~')]).toEqual(['9999-12-30', '9999-12-31'])
  })

  it('never yields more than MAX_REPORT_DAYS days, whatever it is handed', () => {
    expect([...eachReportDay('2026-01-01', '2099-12-31')]).toHaveLength(MAX_REPORT_DAYS)
  })

  it('yields nothing for a reversed or malformed period', () => {
    expect([...eachReportDay('2026-05-10', '2026-05-04')]).toEqual([])
    expect([...eachReportDay('soon', '2026-05-04')]).toEqual([])
  })
})

// RANGEVALID.1 — one rule for every schedule range: a caller with a tighter
// cap or a different noun passes them; a list route whose bounds are each
// optional goes through rangeQueryError.
describe('reportPeriodError — a caller\'s own cap and noun (RANGEVALID.1)', () => {
  it('takes a tighter cap and says whose it is', () => {
    expect(reportPeriodError('2026-01-01', '2026-04-02', { maxDays: 92 })).toBeNull() // 92 days
    expect(reportPeriodError('2026-01-01', '2026-04-03', { maxDays: 92, what: 'The range' })).toBe('The range can cover at most 92 days')
    expect(reportPeriodError('2026-09-01', '2026-10-31', { startName: 'from', endName: 'to', maxDays: 60, what: 'The overview' }))
      .toBe('The overview can cover at most 60 days')
    expect(reportPeriodError('2026-05-04', '2027-05-05', { what: 'A roster' })).toBe('A roster can cover at most 366 days')
    expect(reportPeriodError('2026-05-04', '2027-05-04', { what: 'A roster' })).toBeNull() // 366 days
  })

  it('defaults unchanged: a report, 366 days, period_start/period_end', () => {
    expect(reportPeriodError('2026-01-01', '2027-01-02')).toBe('A report can cover at most 366 days')
    expect(reportPeriodError('2026-05-10', '2026-05-04')).toBe('period_end must be on or after period_start')
  })
})

describe('rangeQueryError — a list route\'s optional bounds (RANGEVALID.1)', () => {
  it('absent or empty bounds are no bound, as the routes have always read them', () => {
    expect(rangeQueryError(null, null)).toBeNull()
    expect(rangeQueryError('', '')).toBeNull()
    expect(rangeQueryError(undefined, undefined)).toBeNull()
  })

  it('a lone bound is only checked for being a real date (there is no span to judge)', () => {
    expect(rangeQueryError('2020-01-01', null)).toBeNull()
    expect(rangeQueryError(null, '2030-12-31')).toBeNull()
    expect(rangeQueryError('soon', null)).toBe('start_date: not a real date')
  })

  it('a bound the calendar does not have keeps DATECHECK.1\'s words', () => {
    expect(rangeQueryError('2026-02-30', '2026-03-06')).toBe('start_date: not a real date')
    expect(rangeQueryError('2026-04-01', '2026-04-31')).toBe('end_date: not a real date')
    expect(rangeQueryError('2026-13-01', null)).toBe('start_date: not a real date')
  })

  it('both bounds: in order', () => {
    expect(rangeQueryError('2026-09-28', '2026-09-27')).toBe('end_date must be on or after start_date')
    expect(rangeQueryError('2026-09-28', '2026-09-28')).toBeNull()
  })

  it('both bounds: at most maxDays (default 366), in the caller\'s noun', () => {
    expect(rangeQueryError('2026-01-01', '2026-04-02', { maxDays: MAX_LIST_RANGE_DAYS })).toBeNull()
    expect(rangeQueryError('2026-01-01', '2026-04-03', { maxDays: MAX_LIST_RANGE_DAYS })).toBe('The range can cover at most 92 days')
    expect(rangeQueryError('2026-01-01', '2027-01-01')).toBeNull()
    expect(rangeQueryError('2026-01-01', '9999-12-31')).toBe('The range can cover at most 366 days')
    // the calendar's month grid (42 days) fits the feeds' cap
    expect(rangeQueryError('2026-08-31', '2026-10-11', { maxDays: MAX_LIST_RANGE_DAYS })).toBeNull()
  })

  it('says the names the caller uses', () => {
    const names = { startName: 'start', endName: 'end' }
    expect(rangeQueryError('2026-10-01', '2026-09-01', names)).toBe('end must be on or after start')
    expect(rangeQueryError('abc', null, names)).toBe('start: not a real date')
  })

  it('the feeds\' cap is 92 days, the availability and change-log routes\' figure', () => {
    expect(MAX_LIST_RANGE_DAYS).toBe(92)
  })
})
