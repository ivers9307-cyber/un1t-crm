import { describe, it, expect } from 'vitest'
import { mapBiologicalSexToGender, parseBodyBlock } from './apple-health-body.js'

describe('mapBiologicalSexToGender', () => {
  it('maps HealthKit values to our enum', () => {
    expect(mapBiologicalSexToGender('female')).toBe('female')
    expect(mapBiologicalSexToGender('male')).toBe('male')
    expect(mapBiologicalSexToGender('other')).toBe('other')
  })
  it('is case-insensitive', () => {
    expect(mapBiologicalSexToGender('Female')).toBe('female')
  })
  it('returns null for notSet / unknown / junk', () => {
    expect(mapBiologicalSexToGender('notSet')).toBeNull()
    expect(mapBiologicalSexToGender(null)).toBeNull()
    expect(mapBiologicalSexToGender('xyz')).toBeNull()
  })
})

describe('parseBodyBlock', () => {
  it('extracts a clean weight + iso timestamp', () => {
    const out = parseBodyBlock({ weight_kg: 70.4, weight_at: '2026-06-27T08:00:00Z' })
    expect(out.weightKg).toBe(70.4)
    expect(out.weightAt).toBe('2026-06-27T08:00:00Z')
  })
  it('defaults weight_at to null and ignores an out-of-range weight', () => {
    expect(parseBodyBlock({ weight_kg: 5 }).weightKg).toBeNull()
    expect(parseBodyBlock({ weight_kg: 500 }).weightKg).toBeNull()
    expect(parseBodyBlock({ weight_kg: 70 }).weightAt).toBeNull()
  })
  it('passes through a valid dob and maps biological_sex', () => {
    const out = parseBodyBlock({ dob: '1990-03-12', biological_sex: 'male' })
    expect(out.dob).toBe('1990-03-12')
    expect(out.gender).toBe('male')
  })
  it('nulls a malformed dob and unknown sex', () => {
    const out = parseBodyBlock({ dob: '12/03/1990', biological_sex: 'notSet' })
    expect(out.dob).toBeNull()
    expect(out.gender).toBeNull()
  })
  it('handles an empty/absent block', () => {
    expect(parseBodyBlock(undefined)).toEqual({ weightKg: null, weightAt: null, dob: null, gender: null })
  })
})
