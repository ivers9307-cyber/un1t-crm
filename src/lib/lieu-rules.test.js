// LIEU.1 — the time-in-lieu rule, pure: Sunday at time and a third, a public
// holiday at base time, the greater once when both, FTE only, cancelled and
// zero-hour shifts earn nothing, and the multiplier a studio's settings carry.
import { describe, it, expect } from 'vitest'
import {
  lieuCreditForShift, sundayLieuMultiplier, lieuBalanceFrom, isSundayDate,
  DEFAULT_SUNDAY_LIEU_MULTIPLIER,
} from './lieu-rules'

function shift(over) {
  return {
    shift_date: '2026-06-07',          // a Sunday
    status: 'scheduled',
    start_time_override: null,
    end_time_override: null,
    block_start_time: '09:00:00',
    block_end_time: '17:00:00',
    profiles: { employment_type: 'fte' },
    shift_templates: { start_time: '08:00:00', end_time: '16:00:00' },
    ...over,
  }
}

describe('isSundayDate', () => {
  it('judges the wall-clock date, zone-free', () => {
    expect(isSundayDate('2026-06-07')).toBe(true)
    expect(isSundayDate('2026-06-08')).toBe(false)
    expect(isSundayDate('')).toBe(false)
    expect(isSundayDate(null)).toBe(false)
  })
})

describe('sundayLieuMultiplier', () => {
  it('defaults to time and a third', () => {
    expect(sundayLieuMultiplier(null)).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
    expect(sundayLieuMultiplier({})).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
    expect(sundayLieuMultiplier({ payroll: {} })).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
    expect(sundayLieuMultiplier({ payroll: { sunday_multiplier: '' } })).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
    expect(DEFAULT_SUNDAY_LIEU_MULTIPLIER).toBeCloseTo(4 / 3, 10)
  })
  it('reads a stored number, as a number or a string', () => {
    expect(sundayLieuMultiplier({ payroll: { sunday_multiplier: 1.5 } })).toBe(1.5)
    expect(sundayLieuMultiplier({ payroll: { sunday_multiplier: '2' } })).toBe(2)
  })
  it('an out-of-range or garbage value is the default, never 0 and never 1', () => {
    expect(sundayLieuMultiplier({ payroll: { sunday_multiplier: 0 } })).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
    expect(sundayLieuMultiplier({ payroll: { sunday_multiplier: 0.5 } })).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
    expect(sundayLieuMultiplier({ payroll: { sunday_multiplier: 9 } })).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
    expect(sundayLieuMultiplier({ payroll: { sunday_multiplier: 'lots' } })).toBe(DEFAULT_SUNDAY_LIEU_MULTIPLIER)
  })
})

describe('lieuCreditForShift', () => {
  it('a Sunday worked by an FTE banks the paid hours × the multiplier', () => {
    expect(lieuCreditForShift({ shift: shift() })).toEqual({
      source: 'sunday_worked', hours: 10.67, worked_hours: 8, multiplier: 1.3333, holiday_name: null,
    })
    expect(lieuCreditForShift({ shift: shift(), sundayMultiplier: 1.5 }).hours).toBe(12)
  })
  it('a public holiday banks base time', () => {
    const c = lieuCreditForShift({ shift: shift({ shift_date: '2026-03-17' }), holidayName: "St Patrick's Day" })
    expect(c).toEqual({ source: 'public_holiday_worked', hours: 8, worked_hours: 8, multiplier: 1, holiday_name: "St Patrick's Day" })
  })
  it('a public holiday on a Sunday banks the greater once, as public_holiday_worked', () => {
    const c = lieuCreditForShift({ shift: shift({ shift_date: '2027-12-26' }), holidayName: "St Stephen's Day" })
    expect(c).toMatchObject({ source: 'public_holiday_worked', hours: 10.67, multiplier: 1.3333, holiday_name: "St Stephen's Day" })
    // a studio below base on Sundays can never pay less than base for the holiday
    expect(lieuCreditForShift({ shift: shift({ shift_date: '2027-12-26' }), holidayName: 'x', sundayMultiplier: 1 }).hours).toBe(8)
  })
  it('an ordinary weekday earns nothing', () => {
    expect(lieuCreditForShift({ shift: shift({ shift_date: '2026-06-08' }) })).toBeNull()
  })
  it('a contractor earns nothing, on either day', () => {
    expect(lieuCreditForShift({ shift: shift({ profiles: { employment_type: 'contractor' } }) })).toBeNull()
    expect(lieuCreditForShift({ shift: shift(), employmentType: 'contractor', holidayName: 'x' })).toBeNull()
    // and an unknown employment type is not assumed to be FTE
    expect(lieuCreditForShift({ shift: shift({ profiles: null }) })).toBeNull()
  })
  it('a cancelled shift earns nothing', () => {
    expect(lieuCreditForShift({ shift: shift({ status: 'cancelled' }) })).toBeNull()
  })
  it('honours the override → block → template hours, like every report', () => {
    expect(lieuCreditForShift({ shift: shift({ start_time_override: '10:00:00', end_time_override: '13:00:00' }) }).worked_hours).toBe(3)
    expect(lieuCreditForShift({ shift: shift({ block_start_time: null, block_end_time: null }) }).worked_hours).toBe(8)   // template
  })
  it('zero or unreadable hours earn nothing', () => {
    expect(lieuCreditForShift({ shift: shift({ block_start_time: '09:00:00', block_end_time: '09:00:00' }) })).toBeNull()
    expect(lieuCreditForShift({ shift: shift({ block_start_time: 'nope', block_end_time: 'x', shift_templates: null }) })).toBeNull()
  })
  it('an overnight Saturday-into-Sunday shift is Saturday (block date), an overnight Sunday counts in full', () => {
    expect(lieuCreditForShift({ shift: shift({ shift_date: '2026-06-06', block_start_time: '22:00:00', block_end_time: '02:00:00' }) })).toBeNull()
    expect(lieuCreditForShift({ shift: shift({ block_start_time: '22:00:00', block_end_time: '02:00:00' }) })).toMatchObject({ worked_hours: 4, hours: 5.33 })
  })
})

describe('lieuBalanceFrom', () => {
  it('credits add, taken subtracts, the balance is the signed sum', () => {
    expect(lieuBalanceFrom([
      { source: 'sunday_worked', hours: '10.67' },
      { source: 'public_holiday_worked', hours: 8 },
      { source: 'manual', hours: 2 },
      { source: 'taken', hours: -4 },
    ])).toEqual({ credited_hours: 20.67, taken_hours: 4, balance_hours: 16.67 })
  })
  it('an empty or unreadable ledger is 0 across the board', () => {
    expect(lieuBalanceFrom([])).toEqual({ credited_hours: 0, taken_hours: 0, balance_hours: 0 })
    expect(lieuBalanceFrom(null)).toEqual({ credited_hours: 0, taken_hours: 0, balance_hours: 0 })
    expect(lieuBalanceFrom([{ source: 'manual', hours: 'x' }])).toEqual({ credited_hours: 0, taken_hours: 0, balance_hours: 0 })
  })
})
