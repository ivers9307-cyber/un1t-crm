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

  // PAYROLL24.1 — Postgres `time` holds '24:00:00': midnight at the END of the
  // day. It used to parse as null, so every shift ending at 24:00 was 0 hours.
  it('reads exactly 24:00 as the end of the day (PAYROLL24.1)', () => {
    expect(timeToHours('24:00')).toBe(24)
    expect(timeToHours('24:00:00')).toBe(24)
  })

  it('refuses everything past 24:00 (PAYROLL24.1)', () => {
    for (const t of ['24:01', '24:00:01', '24:30', '24:60', '25:00', '99:00']) {
      expect(timeToHours(t), t).toBeNull()
    }
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

  // REPORTS.2 — override → block → template (shared/roster-month.js). The
  // template used to win over the row's own (block) times.
  it('prefers the block\'s own times over the template', () => {
    const tpl = { start_time: '06:00', end_time: '07:00' }
    expect(shiftHours({ start_time: '06:00', end_time: '09:00', shift_templates: tpl })).toBe(3)
    expect(shiftHours({ block_start_time: '06:00', block_end_time: '08:30', shift_templates: tpl })).toBe(2.5)
    expect(shiftHours({ start_time_override: '07:00', start_time: '06:00', end_time: '09:00', shift_templates: tpl })).toBe(2)
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

// ─── PAYROLL24.1 — a shift ending at 24:00 ───────────────────────────────────
//
// shiftHours needs no change of its own: once 24 parses, end - start is never
// negative for a 24:00 end, so the overnight wrap never fires. These pin it in
// the three row shapes the callers hand over.

describe('shiftHours — a 24:00 end (PAYROLL24.1)', () => {
  it('a 24:00 end runs to the end of the day', () => {
    // report-generator / roster-week-cost / roster-summary: block times on the row.
    expect(shiftHours({ start_time: '22:00', end_time: '24:00' })).toBe(2)
    // What Postgres hands back.
    expect(shiftHours({ start_time: '22:00:00', end_time: '24:00:00' })).toBe(2)
    expect(shiftHours({ start_time: '18:30:00', end_time: '24:00:00' })).toBe(5.5)
    expect(shiftHours({ start_time: '00:00', end_time: '24:00' })).toBe(24)
    // fetchScheduledShiftRows' normalised shape.
    expect(shiftHours({ block_start_time: '22:00:00', block_end_time: '24:00:00' })).toBe(2)
    // roster-publish.js blockContractorCost: block times inside shift_templates.
    expect(shiftHours({ shift_templates: { start_time: '22:00:00', end_time: '24:00:00' } })).toBe(2)
    // contractor-invoices.js: overrides + block times + template.
    expect(shiftHours({
      start_time_override: null, end_time_override: null,
      start_time: '22:00:00', end_time: '24:00:00',
      shift_templates: { start_time: '09:00:00', end_time: '10:00:00' },
    })).toBe(2)
  })

  it('an override ending at 24:00 wins over the block end', () => {
    expect(shiftHours({ start_time: '21:00:00', end_time: '23:00:00', end_time_override: '24:00:00' })).toBe(3)
  })

  it('00:00 and 24:00 as an end are the same 2 hours; 00:00-00:00 stays 0', () => {
    expect(shiftHours({ start_time: '22:00', end_time: '00:00' })).toBe(2)
    expect(shiftHours({ start_time: '22:00', end_time: '24:00' })).toBe(2)
    expect(shiftHours({ start_time: '00:00', end_time: '00:00' })).toBe(0)
  })

  // Decision D4: a 24:00 START is that same midnight, with the usual wrap. A
  // block cannot start at 24:00 (shift_blocks_time_order, mig 067:90); only an
  // override written by hand could. shared/roster-month and roster-compare
  // read it the same way; workingWindow calls it untimed (hours-24.test.js).
  it('a 24:00 start reads as the same midnight, wrapping', () => {
    expect(shiftHours({ start_time: '24:00', end_time: '02:00' })).toBe(2)
    expect(shiftHours({ start_time: '24:00', end_time: '24:00' })).toBe(0)
  })

  it('a time past 24:00 still counts 0, never NaN', () => {
    expect(shiftHours({ start_time: '22:00', end_time: '24:30' })).toBe(0)
    expect(shiftHours({ start_time: '22:00', end_time: '24:00:01' })).toBe(0)
  })
})

describe('computeWeeklyCost — a 24:00 end is paid (PAYROLL24.1)', () => {
  const fte = { employment_type: 'fte', annual_salary: 52000, contracted_hours_per_week: 40, overtime_rate: 35 } // 25/h
  const late = { start_time: '22:00:00', end_time: '24:00:00' }
  const day = (h) => ({ start_time: '09:00', end_time: `${String(9 + h).padStart(2, '0')}:00` })

  it('counts and costs the 2 hours', () => {
    const r = computeWeeklyCost({ shifts: [late], profile: fte })
    expect(r.actual_hours).toBe(2)
    expect(r.regular_cost).toBe(50)
    expect(r.total_cost).toBe(50)
  })

  it('a 24:00 shift can be the one that crosses into overtime', () => {
    const r = computeWeeklyCost({ shifts: [day(10), day(10), day(10), day(10), late], profile: fte }) // 42h
    expect(r.regular_hours).toBe(40)
    expect(r.overtime_hours).toBe(2)
    expect(r.overtime_cost).toBe(70) // 2 × 35
    expect(r.over_threshold).toBe(true)
  })

  it('a contractor is paid for it', () => {
    const r = computeWeeklyCost({ shifts: [late], profile: { employment_type: 'contractor', hourly_rate: 30 } })
    expect(r.total_cost).toBe(60)
  })
})
