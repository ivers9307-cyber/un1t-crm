// DATECHECK.1 (review) — the one rule for a report's period, shared by
// POST /api/schedule/reports and generateReport, and the bounded day walk.
import { describe, it, expect } from 'vitest'
import { reportPeriodError, eachReportDay, MAX_REPORT_DAYS } from './report-period'

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
