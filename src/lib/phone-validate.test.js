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

  // The trunk zero is dropped when a number is written for a +353 prefix, so
  // the bare 9-digit NSN is a normal way to hold (and type) an Irish mobile —
  // 431 contacts are stored in exactly this shape. toE164Ireland() in twilio.js
  // has always accepted it; this gate used to reject it outright.
  it('accepts the bare 9-digit form with no trunk zero and no country code', () => {
    expect(toMobileE164('871234567')).toBe('+353871234567')
    expect(toMobileE164('87 123 4567')).toBe('+353871234567')
    expect(toMobileE164('83-123-4567')).toBe('+353831234567')
    expect(toMobileE164('851234567')).toBe('+353851234567')
    expect(toMobileE164('861234567')).toBe('+353861234567')
    expect(toMobileE164('891234567')).toBe('+353891234567')
  })

  // Guards the narrowing: bare 8… is deliberately NOT as broad as the 08* used
  // for the trunk-zero form, or 0818 lo-call (not a mobile, not
  // WhatsApp-reachable) would ride in on the new branch.
  //
  // The asymmetry below is intentional. The national 0818 form is accepted
  // today by the pre-existing broad IE_MOBILE_NATIONAL (08*), and this change
  // leaves that exactly as it was — narrowing a live public gate is the
  // separate decision we explicitly declined to make here. The point is only
  // that widening must not ADD a second way in for a non-mobile.
  it('does not widen into 0818 lo-call', () => {
    expect(toMobileE164('818123456')).toBeNull() // bare form — rejected by the new branch
    expect(toMobileE164('0818123456')).toBe('+353818123456') // national form — pre-existing, unchanged
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
