// RANGEVALID.1 — the one rule for a holiday-allowance year.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseAllowanceYear, dublinYear, ALLOWANCE_YEAR_MIN, ALLOWANCE_YEAR_MAX, ALLOWANCE_YEAR_ERROR } from './allowance-year'

afterEach(() => vi.useRealTimers())

describe('parseAllowanceYear (RANGEVALID.1)', () => {
  it('takes a four-digit year in the window, as a number or a query string', () => {
    expect(parseAllowanceYear(2026)).toEqual({ year: 2026, error: null })
    expect(parseAllowanceYear('2026')).toEqual({ year: 2026, error: null })
    expect(parseAllowanceYear('2020')).toEqual({ year: 2020, error: null })
    expect(parseAllowanceYear(2100)).toEqual({ year: 2100, error: null })
  })

  it('refuses anything else, in one sentence', () => {
    expect(ALLOWANCE_YEAR_ERROR).toBe('year must be a four-digit year from 2020 to 2100')
    for (const raw of ['abc', '26', '02026', '2026.5', 2026.5, ' 2026', '2026 ', '1e3', '2026abc', 1999, 2101, '99999', -2026, true, {}, [2026]]) {
      expect(parseAllowanceYear(raw), JSON.stringify(raw)).toEqual({ year: null, error: ALLOWANCE_YEAR_ERROR })
    }
  })

  it('absent means this year on the Dublin calendar, not the server\'s', () => {
    // 03:00 UTC on 1 Jan 2027 is 2027 in Dublin, still 2026 in Los Angeles.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2027-01-01T03:00:00Z') })
    for (const raw of [null, undefined, '']) expect(parseAllowanceYear(raw)).toEqual({ year: 2027, error: null })
    expect(dublinYear()).toBe(2027)
  })

  it('the window is the allowances PUT\'s', () => {
    expect([ALLOWANCE_YEAR_MIN, ALLOWANCE_YEAR_MAX]).toEqual([2020, 2100])
  })
})
