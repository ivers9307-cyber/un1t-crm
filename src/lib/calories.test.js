import { describe, it, expect } from 'vitest'
import { estimateCaloriesKcal } from './calories.js'

describe('estimateCaloriesKcal', () => {
  const base = { avgHr: 144, durationMin: 71, age: 36, weightKg: 68 }

  it('computes a male estimate (Keytel)', () => {
    expect(estimateCaloriesKcal({ ...base, gender: 'male' })).toBeCloseTo(959, -1)
  })
  it('computes a lower female estimate for the same inputs', () => {
    const m = estimateCaloriesKcal({ ...base, gender: 'male' })
    const f = estimateCaloriesKcal({ ...base, gender: 'female' })
    expect(f).toBeLessThan(m)
    expect(f).toBeCloseTo(646, -1)
  })
  it('uses the mean of male & female for other/unknown gender', () => {
    const m = estimateCaloriesKcal({ ...base, gender: 'male' })
    const f = estimateCaloriesKcal({ ...base, gender: 'female' })
    expect(estimateCaloriesKcal({ ...base, gender: 'other' })).toBe(Math.round((m + f) / 2))
    expect(estimateCaloriesKcal({ ...base, gender: null })).toBe(Math.round((m + f) / 2))
    expect(estimateCaloriesKcal({ ...base, gender: 'P' })).toBe(Math.round((m + f) / 2))
  })
  it('scales with duration', () => {
    const a = estimateCaloriesKcal({ ...base, gender: 'male', durationMin: 30 })
    const b = estimateCaloriesKcal({ ...base, gender: 'male', durationMin: 60 })
    expect(b).toBeGreaterThan(a)
  })
  it('returns null when a required input is missing or non-positive', () => {
    expect(estimateCaloriesKcal({ ...base, gender: 'male', weightKg: null })).toBeNull()
    expect(estimateCaloriesKcal({ ...base, gender: 'male', age: null })).toBeNull()
    expect(estimateCaloriesKcal({ ...base, gender: 'male', avgHr: 0 })).toBeNull()
    expect(estimateCaloriesKcal({ ...base, gender: 'male', durationMin: 0 })).toBeNull()
  })
  it('returns a rounded integer', () => {
    expect(Number.isInteger(estimateCaloriesKcal({ ...base, gender: 'male' }))).toBe(true)
  })
})
