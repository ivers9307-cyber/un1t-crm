import { describe, it, expect } from 'vitest'
import { monthBounds, shiftDurationHours, summariseShifts, buildMonthMatrix } from './roster-month.js'

describe('monthBounds', () => {
  it('returns the calendar month containing the anchor (Mon-start unaffected)', () => {
    expect(monthBounds('2026-06-17')).toEqual({ monthStartIso: '2026-06-01', monthEndIso: '2026-06-30' })
  })
  it('handles February + year edges', () => {
    expect(monthBounds('2026-02-15')).toEqual({ monthStartIso: '2026-02-01', monthEndIso: '2026-02-28' })
    expect(monthBounds('2026-12-31')).toEqual({ monthStartIso: '2026-12-01', monthEndIso: '2026-12-31' })
  })
})

describe('shiftDurationHours', () => {
  it('computes from template times', () => {
    expect(shiftDurationHours({ shift_templates: { start_time: '06:30', end_time: '09:30' } })).toBe(3)
  })
  it('honours overrides and wraps past midnight', () => {
    expect(shiftDurationHours({ start_time_override: '22:00', end_time_override: '01:00', shift_templates: {} })).toBe(3)
  })
  it('0 when times missing', () => {
    expect(shiftDurationHours({ shift_templates: {} })).toBe(0)
  })
})

describe('summariseShifts', () => {
  it('counts + sums hours (rounded 1dp)', () => {
    const s = [
      { shift_templates: { start_time: '06:30', end_time: '09:30' } },
      { shift_templates: { start_time: '17:00', end_time: '20:00' } },
    ]
    expect(summariseShifts(s)).toEqual({ count: 2, hours: 6 })
  })
})

describe('buildMonthMatrix', () => {
  // June 2026: 1st = Monday, 30 days.
  const matrix = buildMonthMatrix('2026-06-01', '2026-06-30', [
    { shift_date: '2026-06-17', shift_templates: { name: 'Strength' } },
  ], '2026-06-17')

  it('returns full Mon-start weeks padded to 7', () => {
    expect(matrix.every(w => w.length === 7)).toBe(true)
    expect(matrix[0][0].iso).toBe('2026-06-01') // Mon 1 Jun, no leading pad
  })
  it('flags inMonth / isToday / isPast and attaches shifts by date', () => {
    const all = matrix.flat()
    const today = all.find(d => d.iso === '2026-06-17')
    expect(today.isToday).toBe(true)
    expect(today.shifts).toHaveLength(1)
    expect(all.find(d => d.iso === '2026-06-01').isPast).toBe(true)
    // trailing pad days into July are inMonth:false
    expect(all.some(d => !d.inMonth)).toBe(true)
  })
  it('pads a mid-week month start with leading days', () => {
    // Feb 2026 starts on a Sunday → 6 leading pad days (Mon 26 Jan … Sat 31 Jan)
    const m = buildMonthMatrix('2026-02-01', '2026-02-28', [], '2026-02-10')
    expect(m[0][0].inMonth).toBe(false)
    expect(m[0][6].iso).toBe('2026-02-01') // Sunday 1 Feb is the last cell of row 0
  })
})
