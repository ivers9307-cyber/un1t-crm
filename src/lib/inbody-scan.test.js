import { describe, it, expect } from 'vitest'
import { parseFullInBodyData } from './inbody-scan'

describe('parseFullInBodyData', () => {
  it('maps full-name fields (GetFullInBodyData form)', () => {
    const raw = {
      Weight: '78.4',
      PercentBodyFat: '18.2',
      SkeletalMuscleMass: '36.1',
      BMI: '24.1',
      BasalMetabolicRate: '1680',
      BodyFatMass: '14.3',
      InBodyScore: '82',
    }
    expect(parseFullInBodyData(raw)).toEqual({
      weight_kg: 78.4,
      pbf_percent: 18.2,
      smm_kg: 36.1,
      bmi: 24.1,
      bmr: 1680,
      body_fat_mass_kg: 14.3,
      inbody_score: 82,
    })
  })

  it('maps abbreviation fields (GetInBodyData form)', () => {
    const raw = { WT: 80, PBF: 20, SMM: 35, BMI: 25, BMR: 1700, BFM: 16, InBodyScore: 79 }
    expect(parseFullInBodyData(raw)).toMatchObject({
      weight_kg: 80, pbf_percent: 20, smm_kg: 35, bmi: 25, bmr: 1700,
      body_fat_mass_kg: 16, inbody_score: 79,
    })
  })

  it('is insensitive to case, spaces and punctuation in keys', () => {
    const raw = { 'Percent Body Fat': '18.0', 'Skeletal Muscle Mass': '36.0', 'Body Mass Index': '24' }
    const out = parseFullInBodyData(raw)
    expect(out.pbf_percent).toBe(18.0)
    expect(out.smm_kg).toBe(36.0)
    expect(out.bmi).toBe(24)
  })

  it('returns null for fields that are missing or non-numeric', () => {
    const out = parseFullInBodyData({ Weight: 'n/a', BMI: '' })
    expect(out.weight_kg).toBeNull()
    expect(out.bmi).toBeNull()
    expect(out.smm_kg).toBeNull()
  })

  it('returns an all-null object for a non-object input', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(parseFullInBodyData(bad)).toEqual({
        weight_kg: null, pbf_percent: null, smm_kg: null, bmi: null,
        bmr: null, body_fat_mass_kg: null, inbody_score: null,
      })
    }
  })
})
