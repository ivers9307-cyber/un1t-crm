import { describe, it, expect } from 'vitest'
import { verifyInbodySecret, inbodyDatetimeToIso, parseInbodyNotification } from './inbody-webhook'

describe('verifyInbodySecret', () => {
  it('accepts a matching secret', () => {
    expect(verifyInbodySecret('s3cret-value', 's3cret-value')).toBe(true)
  })
  it('rejects a mismatch', () => {
    expect(verifyInbodySecret('wrong', 's3cret-value')).toBe(false)
  })
  it('rejects when the header or the configured secret is missing', () => {
    expect(verifyInbodySecret(null, 's3cret')).toBe(false)
    expect(verifyInbodySecret('s3cret', '')).toBe(false)
    expect(verifyInbodySecret('s3cret', undefined)).toBe(false)
  })
})

describe('inbodyDatetimeToIso', () => {
  it('parses YYYYMMDDHHMMSS into a tz-naive ISO string', () => {
    expect(inbodyDatetimeToIso('20190811120103')).toBe('2019-08-11T12:01:03')
  })
  it('returns null for malformed / empty input', () => {
    expect(inbodyDatetimeToIso('2019-08-11')).toBeNull()
    expect(inbodyDatetimeToIso('')).toBeNull()
    expect(inbodyDatetimeToIso(null)).toBeNull()
    expect(inbodyDatetimeToIso(20190811120103)).toBeNull() // not a string
  })
})

describe('parseInbodyNotification', () => {
  const sample = {
    EquipSerial: 'CC71700163',
    TelHP: '01012344733',
    UserID: '1234',
    TestDatetimes: '20190811120103',
    Account: 'stillorganun1t',
    Equip: 'InBody770',
    Type: 'InBody',
    IsTempData: 'false',
  }

  it('maps the documented sample payload', () => {
    expect(parseInbodyNotification(sample)).toEqual({
      account: 'stillorganun1t',
      telHp: '01012344733',
      userId: '1234',
      testDatetime: '20190811120103',
      scannedAt: '2019-08-11T12:01:03',
      equip: 'InBody770',
      equipSerial: 'CC71700163',
      isTempData: false,
      type: 'InBody',
    })
  })

  it('coerces IsTempData "true"/boolean and a numeric UserID', () => {
    expect(parseInbodyNotification({ ...sample, IsTempData: 'true' }).isTempData).toBe(true)
    expect(parseInbodyNotification({ ...sample, IsTempData: true }).isTempData).toBe(true)
    expect(parseInbodyNotification({ ...sample, UserID: 1234 }).userId).toBe('1234')
  })

  it('tolerates missing keys (nulls, no throw)', () => {
    expect(parseInbodyNotification({})).toMatchObject({
      account: null, telHp: null, userId: null, testDatetime: null,
      scannedAt: null, isTempData: null,
    })
    expect(parseInbodyNotification(null)).toMatchObject({ account: null })
  })
})
