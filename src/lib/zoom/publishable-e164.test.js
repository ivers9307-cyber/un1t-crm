import { describe, it, expect } from 'vitest'
import {
  e164Rejection, isPublishableE164, countryCodeOf,
  ASSIGNED_COUNTRY_CODES, SERVICE_COUNTRY_CODES, NATIONAL_LENGTHS, E164_REJECTION_LABELS,
} from './publishable-e164'

/**
 * ZOOMSYNC.4 — the table is real data, not invented cases.
 *
 * ACCEPT rows are numbers the live desired set actually contains (19 Aug,
 * 6,339 distinct) and that Zoom is holding today. Every one of them is a
 * regression guard in the dangerous direction: rejecting one deletes a member
 * from staff handsets, which is worse than the bug this file fixes.
 *
 * REJECT rows are every distinct number in that same set these rules refuse —
 * all 12 of them — including the four named in the Vercel runtime log.
 */
const LOGGED_IN_PRODUCTION = [
  ['+87654567890', 'unassigned_country_code'],   // 11 digits, but 87 is no country
  ['+800860588525', 'service_number'],           // +800 UIFN
  ['+35382247706573', 'national_length'],        // IE with 11 national digits
  ['+35386921983289', 'national_length'],        // IE with 11 national digits
]

const REJECTED_IN_LIVE_DATA = [
  ...LOGGED_IN_PRODUCTION,
  ['+87999760107', 'unassigned_country_code'],
  ['+353447534301943', 'national_length'],       // IE, 12 national digits
  ['+35334620130081', 'national_length'],        // IE, 11 national digits
  ['+1293508500', 'national_length'],            // NANP is exactly 10
  ['+35300000000', 'trunk_zero'],
  ['+4407502871075', 'trunk_zero'],              // +44 then the national 0
  ['+9109607976617', 'trunk_zero'],              // +91 then the national 0
]

const ACCEPTED_IN_LIVE_DATA = [
  '+353871001953', '+353851001150', '+353899402156', '+353830000000',  // IE mobiles
  '+353122746166', '+353402437031', '+353214551234',                    // IE landlines
  '+3538994601068',                                                     // IE, 10 national digits
  '+447900022459', '+442890663313',                                     // GB
  '+12012892898', '+19165333045',                                       // NANP
  '+34600275773', '+61403022706', '+919049293507', '+393240573234',
  '+31615359478', '+5511959536395', '+79162124223', '+85298566705',
  '+4237971312', '+6592259099', '+97466515282', '+299123456',
]

describe('e164Rejection — the numbers production actually failed on', () => {
  it.each(LOGGED_IN_PRODUCTION)('rejects %s (the 06-Aug loop) as %s', (number, reason) => {
    expect(e164Rejection(number)).toBe(reason)
  })

  it.each(REJECTED_IN_LIVE_DATA)('rejects %s as %s', (number, reason) => {
    expect(e164Rejection(number)).toBe(reason)
    expect(isPublishableE164(number)).toBe(false)
  })

  it.each(ACCEPTED_IN_LIVE_DATA)('accepts %s, which Zoom is holding today', (number) => {
    expect(e164Rejection(number)).toBeNull()
    expect(isPublishableE164(number)).toBe(true)
  })
})

describe('shape', () => {
  it.each([
    [null], [undefined], [12345678901], [''], ['  '],
    ['353871234567'],        // no +
    ['+353 87 123 4567'],    // spaces: normaliseForZoom's job, not this one
    ['+0353871234567'],      // leading zero is not a country code
    ['+3538712345678901'],   // 16 digits, past E.164's ceiling
    ['+3538'],               // too short to be anything
  ])('rejects %s as not_e164', (value) => {
    expect(e164Rejection(value)).toBe('not_e164')
  })

  it('accepts exactly 15 digits, E.164\'s ceiling', () => {
    // +7 (Russia) has no length rule here, so only the E.164 bound applies.
    expect(e164Rejection('+712345678901234')).toBeNull()
  })
})

describe('country codes', () => {
  it('matches the longest assigned prefix, not the first', () => {
    expect(countryCodeOf('353871234567')).toBe('353')
    expect(countryCodeOf('447700900123')).toBe('44')
    expect(countryCodeOf('12015550123')).toBe('1')
  })

  it('returns null for an unassigned prefix', () => {
    expect(countryCodeOf('87654567890')).toBeNull()
  })

  it('never lists a code in both the assigned and the service set', () => {
    for (const code of SERVICE_COUNTRY_CODES) {
      expect(ASSIGNED_COUNTRY_CODES.has(code)).toBe(false)
    }
  })

  it('rejects every service code as service_number, not as a country', () => {
    for (const code of SERVICE_COUNTRY_CODES) {
      expect(e164Rejection(`+${code}1234567890`.slice(0, 13))).toBe('service_number')
    }
  })
})

describe('national length', () => {
  // Bounds are libphonenumber's possible-length metadata, read at design time.
  it('applies Irish bounds at both ends', () => {
    expect(e164Rejection('+3531234567')).toBeNull()        // 7 national digits
    expect(e164Rejection('+3531234567890')).toBeNull()     // 10 national digits
    expect(e164Rejection('+35312345678901')).toBe('national_length') // 11
  })

  it('pins NANP to exactly 10', () => {
    expect(e164Rejection('+12015550123')).toBeNull()
    expect(e164Rejection('+1201555012')).toBe('national_length')
    expect(e164Rejection('+120155501234')).toBe('national_length')
  })

  it('leaves countries with no entry to the E.164 rules alone', () => {
    // Deliberate: only markets we have authority over get a length rule. A
    // Norwegian number one digit long is not this function's business —
    // over-rejecting removes real members, and the worker parks what Zoom
    // refuses.
    expect(NATIONAL_LENGTHS['47']).toBeUndefined()
    expect(e164Rejection('+47780200880')).toBeNull()
  })

  it('rejects a country code with almost no number after it', () => {
    expect(e164Rejection('+353123')).toBe('not_e164')   // caught by the 8-digit floor
    expect(e164Rejection('+9981234')).toBe('not_e164')
  })
})

describe('trunk zero', () => {
  it('is wrong in almost every country, including ones with no length rule', () => {
    expect(e164Rejection('+490171234567')).toBe('trunk_zero')
    expect(e164Rejection('+3530871234567')).toBe('trunk_zero')
  })

  // The exception this rule got wrong on its first draft. Italy is not an edge
  // case to be clever about — since 1998 the leading 0 IS the landline number,
  // so +39 06… (Rome) and +39 02… (Milan) are correct E.164 and rejecting them
  // would silently drop a member from every staff handset. Prod holds 4 Italian
  // contacts today, all mobiles, so this is a latent false-reject pinned here
  // before it can bite, not a live one.
  it('does NOT fire for the countries whose national number really starts 0', () => {
    expect(e164Rejection('+390612345678')).toBe(null)   // Rome landline
    expect(e164Rejection('+390212345678')).toBe(null)   // Milan landline
    expect(e164Rejection('+3780549882914')).toBe(null)  // San Marino
    expect(e164Rejection('+2250712345678')).toBe(null)  // Côte d'Ivoire, 2021 plan
  })

  it('still accepts an Italian mobile, which never carries the 0', () => {
    expect(e164Rejection('+393331234567')).toBe(null)
  })

  // Exempting a country must not turn it into a hole for placeholders.
  it('rejects an all-zero national number even for an exempt country', () => {
    expect(e164Rejection('+39000000000')).toBe('national_length')
  })
})

describe('reason labels', () => {
  it('names every reason the validator can return', () => {
    const reasons = new Set(REJECTED_IN_LIVE_DATA.map(([, reason]) => reason))
    reasons.add('not_e164')
    for (const reason of reasons) {
      expect(typeof E164_REJECTION_LABELS[reason]).toBe('string')
    }
  })
})
