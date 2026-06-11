// Pure-helper tests for contractor-invoices.js. The lib module
// depends on shiftHours from payroll.js (already tested in
// payroll.test.js) and on a Supabase client passed in (skipped here
// — that's an integration concern). These tests cover the date math
// and option generators which are easy to get subtly wrong.

import { describe, it, expect } from 'vitest'
import {
  periodForMonth,
  recentMonthOptions,
  defaultMonthKey,
  periodLabel,
  buildPdfPath,
  isContractorPdfPath,
} from './contractor-invoices'

describe('periodForMonth', () => {
  it('returns 1st → last day for May 2026 (31 days)', () => {
    const p = periodForMonth('2026-05')
    expect(p.period_start).toBe('2026-05-01')
    expect(p.period_end).toBe('2026-05-31')
    expect(p.label).toMatch(/May.*2026/)
  })
  it('returns 1st → last day for February 2024 (leap year)', () => {
    const p = periodForMonth('2024-02')
    expect(p.period_start).toBe('2024-02-01')
    expect(p.period_end).toBe('2024-02-29')
  })
  it('returns 1st → last day for February 2025 (non-leap)', () => {
    const p = periodForMonth('2025-02')
    expect(p.period_start).toBe('2025-02-01')
    expect(p.period_end).toBe('2025-02-28')
  })
  it('handles December (year boundary)', () => {
    const p = periodForMonth('2026-12')
    expect(p.period_start).toBe('2026-12-01')
    expect(p.period_end).toBe('2026-12-31')
  })
  it('throws on invalid month key', () => {
    expect(() => periodForMonth('2026-13')).toThrow()
    expect(() => periodForMonth('2026-1')).toThrow()
    expect(() => periodForMonth('not-a-date')).toThrow()
  })
})

describe('recentMonthOptions', () => {
  it('returns count entries newest-first', () => {
    const now = new Date(Date.UTC(2026, 4, 15)) // May 15
    const opts = recentMonthOptions(now, 4)
    expect(opts.length).toBe(4)
    expect(opts[0].key).toBe('2026-05')
    expect(opts[1].key).toBe('2026-04')
    expect(opts[2].key).toBe('2026-03')
    expect(opts[3].key).toBe('2026-02')
  })
  it('crosses year boundary correctly', () => {
    const now = new Date(Date.UTC(2026, 1, 10)) // Feb 10 2026
    const opts = recentMonthOptions(now, 3)
    expect(opts[0].key).toBe('2026-02')
    expect(opts[1].key).toBe('2026-01')
    expect(opts[2].key).toBe('2025-12')
  })
})

describe('defaultMonthKey', () => {
  it('returns the previous calendar month', () => {
    expect(defaultMonthKey(new Date(Date.UTC(2026, 4, 15)))).toBe('2026-04')
    expect(defaultMonthKey(new Date(Date.UTC(2026, 0, 5)))).toBe('2025-12')
  })
})

describe('periodLabel', () => {
  it('formats a period start as a long-month label', () => {
    expect(periodLabel('2026-05-01')).toMatch(/May.*2026/)
    expect(periodLabel('2024-02-01')).toMatch(/February.*2024/)
  })
})

describe('buildPdfPath', () => {
  it('namespaces by contractor + period + sanitises filename', () => {
    const p = buildPdfPath({
      contractorId: 'abc-123',
      periodStart: '2026-05-01',
      originalFilename: 'My Invoice (2026-05).pdf',
    })
    expect(p).toMatch(/^abc-123\/2026-05-01-[a-z0-9]{6}-My_Invoice__2026-05_\.pdf$/)
  })
  it('handles missing filename', () => {
    const p = buildPdfPath({
      contractorId: 'x',
      periodStart: '2026-05-01',
      originalFilename: null,
    })
    expect(p).toMatch(/^x\/2026-05-01-[a-z0-9]{6}-invoice\.pdf$/)
  })
})

describe('isContractorPdfPath', () => {
  const me = '0c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5'
  const other = '9b2e7c4a-1111-2222-3333-444455556666'

  it('accepts a buildPdfPath-shaped key in the contractor own folder', () => {
    const p = buildPdfPath({ contractorId: me, periodStart: '2026-05-01', originalFilename: 'May Invoice.pdf' })
    expect(isContractorPdfPath(p, me)).toBe(true)
  })

  it('rejects another contractor folder, traversal, nesting, and junk', () => {
    expect(isContractorPdfPath(`${other}/2026-05-01-abc123-invoice.pdf`, me)).toBe(false)
    expect(isContractorPdfPath(`${me}/../${other}/x.pdf`, me)).toBe(false)
    expect(isContractorPdfPath(`${me}/a/b.pdf`, me)).toBe(false)
    expect(isContractorPdfPath('', me)).toBe(false)
    expect(isContractorPdfPath(`${me}/`, me)).toBe(false)
    expect(isContractorPdfPath(`${me}/file with spaces.pdf`, me)).toBe(false)
  })
})
