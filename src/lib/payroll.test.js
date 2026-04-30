import { describe, it, expect } from 'vitest'
import {
  timeToHours, shiftHours, implicitHourlyRate, computeWeeklyCost,
  groupShiftsByWeek, mondayOf,
} from './payroll.js'

describe('timeToHours', () => {
  it('parses HH:MM correctly', () => {
    expect(timeToHours('09:30')).toBe(9.5)
    expect(timeToHours('00:00')).toBe(0)
    expect(timeToHours('23:59')).toBeCloseTo(23.9833, 3)
  })

  it('parses HH:MM:SS correctly', () => {
    expect(timeToHours('01:30:00')).toBe(1.5)
    expect(timeToHours('00:00:30')).toBeCloseTo(30 / 3600, 4)
  })

  it('returns null for missing or malformed input', () => {
    expect(timeToHours('')).toBeNull()
    expect(timeToHours(null)).toBeNull()
    expect(timeToHours('not-a-time')).toBeNull()
    expect(timeToHours('25:00')).toBeNull()    // hour out of range
    expect(timeToHours('12:60')).toBeNull()    // minute out of range
  })
})

describe('shiftHours', () => {
  it('uses shift_templates start/end by default', () => {
    const s = { shift_templates: { start_time: '09:00', end_time: '17:00' } }
    expect(shiftHours(s)).toBe(8)
  })

  it('honours overrides over template values', () => {
    const s = {
      shift_templates: { start_time: '09:00', end_time: '17:00' },
      start_time_override: '08:00',
      end_time_override: '18:30',
    }
    expect(shiftHours(s)).toBe(10.5)
  })

  it('treats end < start as crossing midnight', () => {
    const s = { shift_templates: { start_time: '22:00', end_time: '06:00' } }
    expect(shiftHours(s)).toBe(8)
  })

  it('returns 0 when times are missing', () => {
    expect(shiftHours({ shift_templates: {} })).toBe(0)
    expect(shiftHours(null)).toBe(0)
  })
})

describe('implicitHourlyRate', () => {
  it('computes from salary / 52 / contracted hours', () => {
    const profile = { employment_type: 'fte', annual_salary: 52000, contracted_hours_per_week: 40 }
    // 52000 / 52 / 40 = 25
    expect(implicitHourlyRate(profile)).toBe(25)
  })

  it('returns hourly_rate directly for contractors', () => {
    const profile = { employment_type: 'contractor', hourly_rate: 35.50 }
    expect(implicitHourlyRate(profile)).toBe(35.50)
  })

  it('returns 0 when required fields are missing', () => {
    expect(implicitHourlyRate(null)).toBe(0)
    expect(implicitHourlyRate({ employment_type: 'fte' })).toBe(0)
    expect(implicitHourlyRate({ employment_type: 'fte', annual_salary: 0, contracted_hours_per_week: 40 })).toBe(0)
  })
})

describe('computeWeeklyCost', () => {
  const fteProfile = {
    employment_type: 'fte',
    annual_salary: 52000,        // implicit hourly = 25
    contracted_hours_per_week: 40,
    overtime_rate: 35,           // explicit OT rate
  }

  function shift(hours) {
    return { shift_templates: { start_time: '09:00', end_time: `${9 + hours}:00`.padStart(5, '0') } }
  }

  it('returns zero cost for no shifts', () => {
    const r = computeWeeklyCost({ shifts: [], profile: fteProfile })
    expect(r.actual_hours).toBe(0)
    expect(r.total_cost).toBe(0)
    expect(r.over_threshold).toBe(false)
  })

  it('handles under-contracted hours (no OT)', () => {
    const r = computeWeeklyCost({
      shifts: [shift(8), shift(8), shift(8), shift(8)], // 32 hours
      profile: fteProfile,
    })
    expect(r.actual_hours).toBe(32)
    expect(r.regular_hours).toBe(32)
    expect(r.overtime_hours).toBe(0)
    expect(r.regular_cost).toBe(800)  // 32 * 25
    expect(r.overtime_cost).toBe(0)
    expect(r.total_cost).toBe(800)
    expect(r.over_threshold).toBe(false)
  })

  it('handles exactly contracted hours (boundary, no OT)', () => {
    const r = computeWeeklyCost({
      shifts: [shift(8), shift(8), shift(8), shift(8), shift(8)], // 40 hours
      profile: fteProfile,
    })
    expect(r.regular_hours).toBe(40)
    expect(r.overtime_hours).toBe(0)
    expect(r.over_threshold).toBe(false)
    expect(r.total_cost).toBe(1000)
  })

  it('splits regular vs overtime above threshold using explicit OT rate', () => {
    const r = computeWeeklyCost({
      shifts: [shift(10), shift(10), shift(10), shift(10), shift(5)], // 45 hours
      profile: fteProfile,
    })
    expect(r.regular_hours).toBe(40)
    expect(r.overtime_hours).toBe(5)
    expect(r.regular_cost).toBe(1000)  // 40 * 25
    expect(r.overtime_cost).toBe(175)  // 5 * 35
    expect(r.total_cost).toBe(1175)
    expect(r.over_threshold).toBe(true)
  })

  it('falls back to regular rate when overtime_rate is null (no premium)', () => {
    const r = computeWeeklyCost({
      shifts: [shift(10), shift(10), shift(10), shift(10), shift(5)], // 45 hours
      profile: { ...fteProfile, overtime_rate: null },
    })
    expect(r.overtime_hours).toBe(5)
    expect(r.overtime_cost).toBe(125)  // 5 * 25 (regular rate fallback)
    expect(r.total_cost).toBe(1125)
    expect(r.over_threshold).toBe(true)
  })

  it('falls back to regular rate when overtime_rate is 0', () => {
    const r = computeWeeklyCost({
      shifts: [shift(10), shift(10), shift(10), shift(10), shift(5)],
      profile: { ...fteProfile, overtime_rate: 0 },
    })
    expect(r.overtime_cost).toBe(125)
  })

  it('treats contractors as all-regular regardless of hours', () => {
    const contractor = { employment_type: 'contractor', hourly_rate: 30 }
    const r = computeWeeklyCost({
      shifts: [shift(10), shift(10), shift(10), shift(10), shift(10)], // 50 hours
      profile: contractor,
    })
    expect(r.regular_hours).toBe(50)
    expect(r.overtime_hours).toBe(0)
    expect(r.total_cost).toBe(1500)
    expect(r.over_threshold).toBe(false)
  })
})

describe('mondayOf', () => {
  it('returns the Monday of the same week for a Wednesday', () => {
    expect(mondayOf('2026-04-29')).toBe('2026-04-27')  // Wed → Mon
  })

  it('returns the input itself for a Monday', () => {
    expect(mondayOf('2026-04-27')).toBe('2026-04-27')
  })

  it('returns the previous Monday for a Sunday', () => {
    expect(mondayOf('2026-05-03')).toBe('2026-04-27')  // Sun → previous Mon
  })

  it('handles month and year boundaries', () => {
    expect(mondayOf('2026-01-01')).toBe('2025-12-29')  // Thu → previous Mon
  })
})

describe('groupShiftsByWeek', () => {
  it('groups shifts by Monday of their week', () => {
    const shifts = [
      { shift_date: '2026-04-27', id: 'a' },  // Mon
      { shift_date: '2026-04-30', id: 'b' },  // Thu (same week)
      { shift_date: '2026-05-04', id: 'c' },  // Mon (next week)
    ]
    const m = groupShiftsByWeek(shifts)
    expect(m.size).toBe(2)
    expect(m.get('2026-04-27')).toHaveLength(2)
    expect(m.get('2026-05-04')).toHaveLength(1)
  })

  it('handles empty input', () => {
    expect(groupShiftsByWeek([]).size).toBe(0)
    expect(groupShiftsByWeek(null).size).toBe(0)
  })

  it('skips shifts without a date', () => {
    const m = groupShiftsByWeek([{ id: 'no-date' }])
    expect(m.size).toBe(0)
  })
})
