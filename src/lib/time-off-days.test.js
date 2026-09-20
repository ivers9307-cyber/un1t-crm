import { describe, it, expect } from 'vitest'
import { countLeaveDays, splitAtYearEnd, nonWorkingDateSet } from './time-off-days'

describe('countLeaveDays', () => {
  it('counts Mon-Fri only for holiday', () => {
    // 2026-06-01 (Mon) → 2026-06-07 (Sun) = 5 working days
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07')).toBe(5)
  })
  it('counts every calendar day for non-holiday types', () => {
    expect(countLeaveDays('sick', '2026-06-01', '2026-06-07')).toBe(7)
  })
  it('a weekend-only holiday is 0 days', () => {
    expect(countLeaveDays('holiday', '2026-06-06', '2026-06-07')).toBe(0)
  })
  // HOLIDAYLEAVE.1 — a bank holiday inside a holiday request costs no allowance.
  it('holiday: a weekday in the non-working set is not charged', () => {
    // Mon 1 Jun 2026 is the June Public Holiday.
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07', new Set(['2026-06-01']))).toBe(4)
  })
  it('holiday: a non-working date that is ALREADY a weekend is not subtracted twice', () => {
    // Sat 13 Jun is in the set AND a weekend: still 5, not 4.
    expect(countLeaveDays('holiday', '2026-06-08', '2026-06-14', new Set(['2026-06-13']))).toBe(5)
  })
  it('holiday: a single day that is a bank holiday is 0 days', () => {
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-01', new Set(['2026-06-01']))).toBe(0)
  })
  it('other types ignore the set: sick and unavailable stay calendar days', () => {
    expect(countLeaveDays('sick', '2026-06-01', '2026-06-07', new Set(['2026-06-01']))).toBe(7)
    expect(countLeaveDays('unavailable', '2026-06-01', '2026-06-07', new Set(['2026-06-01']))).toBe(7)
  })
  it('no set, null, or an empty set = the old Mon-Fri count', () => {
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07')).toBe(5)
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07', null)).toBe(5)
    expect(countLeaveDays('holiday', '2026-06-01', '2026-06-07', new Set())).toBe(5)
  })
})
describe('splitAtYearEnd', () => {
  it('returns one range inside a year', () => {
    expect(splitAtYearEnd('2026-06-01', '2026-06-03')).toEqual([['2026-06-01', '2026-06-03']])
  })
  it('splits a range straddling 31 Dec', () => {
    expect(splitAtYearEnd('2026-12-30', '2027-01-02')).toEqual([['2026-12-30', '2026-12-31'], ['2027-01-01', '2027-01-02']])
  })
  it('keeps splitting across more than one year end', () => {
    expect(splitAtYearEnd('2026-12-30', '2028-01-02')).toEqual([
      ['2026-12-30', '2026-12-31'],
      ['2027-01-01', '2027-12-31'],
      ['2028-01-01', '2028-01-02'],
    ])
  })
})
describe('nonWorkingDateSet', () => {
  it('Ireland by default: the national list inside the range', () => {
    const s = nonWorkingDateSet({ start: '2026-05-25', end: '2026-06-07' })
    expect([...s]).toEqual(['2026-06-01'])
  })
  it('adds the studio\'s own closures, and ignores ones outside the range', () => {
    const s = nonWorkingDateSet({
      country: 'IE', start: '2026-06-01', end: '2026-06-14',
      customHolidays: [{ date: '2026-06-10', name: 'Studio closed' }, { date: '2026-07-01', name: 'Later' }],
    })
    expect([...s].sort()).toEqual(['2026-06-01', '2026-06-10'])
  })
  it('follows the studio\'s country: 1 Jun is not a UK holiday, 25 May is', () => {
    const s = nonWorkingDateSet({ country: 'GB', start: '2026-05-25', end: '2026-06-07' })
    expect([...s]).toEqual(['2026-05-25'])
  })
  it('a country with no static list still honours the studio\'s closures', () => {
    const s = nonWorkingDateSet({ country: 'ZZ', start: '2026-06-01', end: '2026-06-07', customHolidays: [{ date: '2026-06-03', name: 'Closed' }] })
    expect([...s]).toEqual(['2026-06-03'])
  })
})
