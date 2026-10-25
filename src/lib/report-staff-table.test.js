// STAFFCOST.1 — reading stored staff_cost rows: current fields, legacy
// fields, and never NaN.
import { describe, it, expect } from 'vitest'
import {
  EMPTY_CELL, formatEuroCell, formatHoursCell, readStaffCostRow, readStaffHoursTotal, staffCostHasSplit,
} from './report-staff-table'

// The exact shape generateReport writes today (report-generator.js).
const CURRENT = {
  name: 'Anna', role: 'head_coach', employment_type: 'fte',
  regular_rate: 23.08, overtime_rate: 30, weeks: {},
  regular_hours: 40, overtime_hours: 4.5, regular_cost: 923.2, overtime_cost: 135, total_cost: 1058.2,
}
// What rows looked like before the overtime change.
const LEGACY = { name: 'Ben', role: 'staff', employment_type: 'contractor', hourly_rate: 25, total_hours: 12, total_cost: 300 }

describe('readStaffCostRow', () => {
  it('reads the current fields; total hours = regular + overtime', () => {
    expect(readStaffCostRow(CURRENT)).toEqual({
      rate: 23.08, overtimeRate: 30, regularHours: 40, overtimeHours: 4.5, totalHours: 44.5, totalCost: 1058.2, hasSplit: true,
    })
  })

  it('falls back field by field for a legacy row', () => {
    expect(readStaffCostRow(LEGACY)).toEqual({
      rate: 25, overtimeRate: null, regularHours: 12, overtimeHours: null, totalHours: 12, totalCost: 300, hasSplit: false,
    })
  })

  it('a mixed row prefers the current name per field', () => {
    const r = readStaffCostRow({ regular_rate: 20, hourly_rate: 99, regular_hours: 5, total_hours: 99 })
    expect(r.rate).toBe(20)
    expect(r.totalHours).toBe(5)
  })

  it('garbage becomes null, never NaN', () => {
    const r = readStaffCostRow({ regular_rate: 'abc', total_cost: undefined, overtime_rate: null })
    for (const v of Object.values(r)) expect(Number.isNaN(v)).toBe(false)
    expect(r.rate).toBeNull()
    expect(r.totalHours).toBeNull()
    expect(readStaffCostRow().totalCost).toBeNull()
  })

  it('rounds the summed hours to one decimal', () => {
    expect(readStaffCostRow({ regular_hours: 0.1, overtime_hours: 0.2 }).totalHours).toBe(0.3)
  })
})

describe('formatters', () => {
  it('render a dash for anything not a finite number', () => {
    for (const v of [null, undefined, NaN, Infinity, 'x', '']) {
      expect(formatEuroCell(v)).toBe(EMPTY_CELL)
      expect(formatHoursCell(v)).toBe(EMPTY_CELL)
    }
  })

  it('format real values', () => {
    expect(formatEuroCell(23.08)).toBe('€23.08')
    expect(formatEuroCell(0)).toBe('€0.00')
    expect(formatHoursCell(44.46)).toBe('44.5')
    expect(formatHoursCell(0)).toBe('0')
  })
})

describe('helpers', () => {
  it('staffCostHasSplit is true for current reports and false for legacy ones', () => {
    expect(staffCostHasSplit([CURRENT, LEGACY])).toBe(true)
    expect(staffCostHasSplit([LEGACY])).toBe(false)
    expect(staffCostHasSplit(undefined)).toBe(false)
  })

  it('readStaffHoursTotal reads staff_hours `total` or a legacy `total_hours`', () => {
    expect(readStaffHoursTotal({ total: 17.25 })).toBe(17.3)
    expect(readStaffHoursTotal({ total_hours: 8 })).toBe(8)
    expect(readStaffHoursTotal({})).toBeNull()
  })
})
