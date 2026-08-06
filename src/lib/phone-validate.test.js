import { describe, it, expect } from 'vitest'
import { toMobileE164, isValidMobileNumber } from './phone-validate'

describe('toMobileE164 — Irish mobiles', () => {
  it('accepts national 08X forms (spaces/dashes ignored)', () => {
    expect(toMobileE164('0871234567')).toBe('+353871234567')
    expect(toMobileE164('087 123 4567')).toBe('+353871234567')
    expect(toMobileE164('085-123-4567')).toBe('+353851234567')
    expect(toMobileE164('089 123 4567')).toBe('+353891234567')
  })
  it('accepts +353 / 00353 / bare 353 country-coded forms', () => {
    expect(toMobileE164('+353 87 123 4567')).toBe('+353871234567')
    expect(toMobileE164('00353871234567')).toBe('+353871234567')
    expect(toMobileE164('353871234567')).toBe('+353871234567')
  })
})

describe('toMobileE164 — UK mobiles', () => {
  it('accepts 07… national and +44 forms', () => {
    expect(toMobileE164('07911123456')).toBe('+447911123456')
    expect(toMobileE164('+44 7911 123456')).toBe('+447911123456')
    expect(toMobileE164('00447911123456')).toBe('+447911123456')
  })
})

describe('toMobileE164 — international fallback', () => {
  it('accepts a well-formed E.164 from another country', () => {
    expect(toMobileE164('+34 612 345 678')).toBe('+34612345678') // Spain mobile
  })
})

describe('isValidMobileNumber — rejects non-mobiles + junk', () => {
  it('rejects Irish landlines, short numbers, and gibberish', () => {
    expect(isValidMobileNumber('01 5551234')).toBe(false) // Dublin landline
    expect(isValidMobileNumber('1234567')).toBe(false) // too short / not a mobile prefix
    expect(isValidMobileNumber('0000000000')).toBe(false) // all-zero national, not 08/07
    expect(isValidMobileNumber('+1111111111')).toBe(false) // all-same intl junk
    expect(isValidMobileNumber('not a phone')).toBe(false)
    expect(isValidMobileNumber('')).toBe(false)
    expect(isValidMobileNumber(null)).toBe(false)
    expect(isValidMobileNumber('086123456')).toBe(false) // 9 digits — one short of an IE mobile
  })
  it('returns true for the valid forms', () => {
    expect(isValidMobileNumber('087 123 4567')).toBe(true)
    expect(isValidMobileNumber('+353871234567')).toBe(true)
  })
})

describe('toMobileE164 — 353 with national trunk zero', () => {
  it('repairs the double prefix rather than passing it through', () => {
    expect(toMobileE164('+3530871234567')).toBe('+353871234567')
    expect(toMobileE164('3530871234567')).toBe('+353871234567')
    expect(toMobileE164('003530871234567')).toBe('+353871234567')
  })

  it('still rejects a 353-prefixed non-mobile', () => {
    expect(toMobileE164('+35315551234')).toBeNull()
  })
})
