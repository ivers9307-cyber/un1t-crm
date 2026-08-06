import { describe, it, expect } from 'vitest'
import { normaliseForZoom } from './normalise-phone'

describe('normaliseForZoom', () => {
  it('keeps a well-formed E.164 number as-is', () => {
    expect(normaliseForZoom('+353871234567')).toBe('+353871234567')
  })

  it('strips separators', () => {
    expect(normaliseForZoom('+353 (87) 123-4567')).toBe('+353871234567')
  })

  it('still accepts ordinary human separators', () => {
    expect(normaliseForZoom('(087) 123-4567')).toBe('+353871234567')
    expect(normaliseForZoom('+353 87 123 4567')).toBe('+353871234567')
    expect(normaliseForZoom('087.123.4567')).toBe('+353871234567')
  })

  it('sees through Unicode direction marks around a pasted number', () => {
    expect(normaliseForZoom('‪+353 85 262 0774‬')).toBe('+353852620774')
  })

  it('converts a 00 international prefix to +', () => {
    expect(normaliseForZoom('00353871234567')).toBe('+353871234567')
  })

  // The 00-strip must run before every other branch; without it, 00-prefixed
  // numbers fall through to the national rules and get mangled.
  it('handles a 00 prefix combined with the trunk-zero defect', () => {
    expect(normaliseForZoom('003530871234567')).toBe('+353871234567')
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

  it('pins the digit-length bounds', () => {
    expect(normaliseForZoom('+12345678')).toBe('+12345678')        // 8, the floor
    expect(normaliseForZoom('+1234567')).toBeNull()                // 7
    expect(normaliseForZoom('+123456789012345')).toBe('+123456789012345') // 15, the ceiling
    expect(normaliseForZoom('+1234567890123456')).toBeNull()       // 16
  })

  // A bare number too short to carry a country code must be rejected, not
  // published with its leading digits masquerading as one. All real stored
  // values from `contacts`; +6978291516 is the one Zoom rejected outright
  // during the go-live pilot (69 is not an assigned country code — it is a
  // Greek mobile missing its +30).
  it('rejects a bare number too short to contain a country code', () => {
    expect(normaliseForZoom('6978291516')).toBeNull()   // Greek mobile, no +30
    expect(normaliseForZoom('3475717693')).toBeNull()   // US, no +1
    expect(normaliseForZoom('3125221673')).toBeNull()
    expect(normaliseForZoom('25880855')).toBeNull()     // 8 digits, no country code
    expect(normaliseForZoom('85225058')).toBeNull()
  })

  it('still accepts a bare number long enough to carry a country code', () => {
    expect(normaliseForZoom('447700900123')).toBe('+447700900123')
    expect(normaliseForZoom('353871234567')).toBe('+353871234567')
  })

  it('does not reject short numbers that an explicit + vouches for', () => {
    // hasPlus means the author asserted a country code; only bare digits are
    // ambiguous, so the new rule must not touch these.
    expect(normaliseForZoom('+12345678')).toBe('+12345678')
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

  it('rejects junk characters rather than splicing the digits around them', () => {
    // All real rows from the contacts table.
    expect(normaliseForZoom('085143”754')).toBeNull()
    expect(normaliseForZoom('0&63301306')).toBeNull()
    expect(normaliseForZoom('087093061:')).toBeNull()
    expect(normaliseForZoom('#832007475')).toBeNull()
    expect(normaliseForZoom('353896161640@ymail.com06')).toBeNull()
    expect(normaliseForZoom('boothjody@gmail.com')).toBeNull()
  })
})
