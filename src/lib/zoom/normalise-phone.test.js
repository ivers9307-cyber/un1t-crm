import { describe, it, expect } from 'vitest'
import { normaliseForZoom } from './normalise-phone'

describe('normaliseForZoom', () => {
  it('keeps a well-formed E.164 number as-is', () => {
    expect(normaliseForZoom('+353871234567')).toBe('+353871234567')
  })

  it('strips separators', () => {
    expect(normaliseForZoom('+353 (87) 123-4567')).toBe('+353871234567')
  })

  it('converts a 00 international prefix to +', () => {
    expect(normaliseForZoom('00353871234567')).toBe('+353871234567')
  })

  // The 106-row defect: country code 353 followed by the national trunk 0.
  // Must drop the trunk zero, NOT pass through as a valid foreign number.
  it('repairs the 353-then-trunk-zero double prefix', () => {
    expect(normaliseForZoom('+3530871234567')).toBe('+353871234567')
    expect(normaliseForZoom('3530871234567')).toBe('+353871234567')
  })

  it('adds + to bare country-coded digits', () => {
    expect(normaliseForZoom('353871234567')).toBe('+353871234567')
  })

  it('expands an Irish national number', () => {
    expect(normaliseForZoom('0871234567')).toBe('+353871234567')
  })

  it('treats an 11-digit 07 number as UK, not Irish', () => {
    expect(normaliseForZoom('07700900123')).toBe('+447700900123')
  })

  it('still treats a 10-digit 08 number as Irish', () => {
    expect(normaliseForZoom('0871234567')).toBe('+353871234567')
  })

  it('does not reclaim an explicit +3530 number as UK', () => {
    expect(normaliseForZoom('+3530871234567')).toBe('+353871234567')
  })

  // Landlines matter here even though toMobileE164() rejects them — a landline
  // that rings the studio still deserves a name on the handset.
  it('keeps an Irish landline', () => {
    expect(normaliseForZoom('012345678')).toBe('+35312345678')
  })

  it('keeps a UK number', () => {
    expect(normaliseForZoom('+447700900123')).toBe('+447700900123')
  })

  it('assumes Ireland for bare national digits with no trunk zero', () => {
    expect(normaliseForZoom('871234567')).toBe('+353871234567')
  })

  it('rejects the ClassPass placeholder', () => {
    expect(normaliseForZoom('+10000000000')).toBeNull()
  })

  it('rejects junk', () => {
    expect(normaliseForZoom('')).toBeNull()
    expect(normaliseForZoom(null)).toBeNull()
    expect(normaliseForZoom('   ')).toBeNull()
    expect(normaliseForZoom('n/a')).toBeNull()
    expect(normaliseForZoom('12345')).toBeNull()          // too short
    expect(normaliseForZoom('+1111111111111')).toBeNull() // all same digit
  })
})
