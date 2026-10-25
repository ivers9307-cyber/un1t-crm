// record-time.test.js — TZ.16 (D3 = A). A record's instant is shown in the
// record's studio zone; the zone's abbreviation is appended ONLY when that zone
// differs from the viewer's. Dublin staff on Dublin records see no change.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test: nothing may read the host clock
import { describe, it, expect } from 'vitest'

const { formatRecordTime, needsZoneSuffix, zoneAbbreviation, zoneCity } = await import('./record-time.js')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
const OPTS = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }

describe('needsZoneSuffix', () => {
  it('is false when the viewer is unknown (server render, UTC browser, privacy mode)', () => {
    expect(needsZoneSuffix(NY, null)).toBe(false)
    expect(needsZoneSuffix(NY, undefined)).toBe(false)
    expect(needsZoneSuffix(NY, '')).toBe(false)
    expect(needsZoneSuffix(NY, 'Not/AZone')).toBe(false)
  })
  it('is false for the same zone, compared through canonicalZone (alias spellings agree)', () => {
    expect(needsZoneSuffix(D, D)).toBe(false)
    expect(needsZoneSuffix('Asia/Kolkata', 'Asia/Calcutta')).toBe(false)
    expect(needsZoneSuffix('europe/dublin', D)).toBe(false)
  })
  it('is true when the record zone differs from the viewer zone', () => {
    expect(needsZoneSuffix(NY, D)).toBe(true)
    expect(needsZoneSuffix(D, NY)).toBe(true)
    // Same offset all year, different zone: still named (the record says where it is).
    expect(needsZoneSuffix('Europe/London', D)).toBe(true)
  })
  it('treats an unresolvable record zone as the Dublin floor', () => {
    expect(needsZoneSuffix(null, D)).toBe(false)
    expect(needsZoneSuffix(null, NY)).toBe(true)
  })
})

describe('zoneAbbreviation', () => {
  it('names the zone as a person would read it, across DST', () => {
    expect(zoneAbbreviation('2026-01-15T12:00:00Z', NY)).toBe('EST')
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', NY)).toBe('EDT')
    expect(zoneAbbreviation('2026-01-15T12:00:00Z', D)).toBe('GMT')
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', D)).toBe('IST')
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', 'Europe/London')).toBe('BST')
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', 'Europe/Berlin')).toBe('CEST')
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', 'Australia/Sydney')).toBe('AEST')
    expect(zoneAbbreviation('2026-01-15T12:00:00Z', 'Australia/Sydney')).toBe('AEDT')
  })
  it('falls back to the GMT offset for a zone with no common abbreviation', () => {
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', 'Asia/Kuwait')).toBe('GMT+3')
    expect(zoneAbbreviation('2026-07-15T12:00:00Z', 'Asia/Kolkata')).toBe('GMT+5:30')
  })
  it('flips exactly at the 2026 US DST changes', () => {
    expect(zoneAbbreviation('2026-03-08T06:59:00Z', NY)).toBe('EST')
    expect(zoneAbbreviation('2026-03-08T07:00:00Z', NY)).toBe('EDT')
    expect(zoneAbbreviation('2026-11-01T05:59:00Z', NY)).toBe('EDT')
    expect(zoneAbbreviation('2026-11-01T06:00:00Z', NY)).toBe('EST')
  })
  it('is empty for an unparseable instant', () => {
    expect(zoneAbbreviation('nope', NY)).toBe('')
  })
})

describe('formatRecordTime', () => {
  it('Dublin record, Dublin viewer: exactly Date#toLocaleString in Dublin, every hour of 2026', () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3600_000) {
      const legacy = new Date(t).toLocaleString('en-IE', { ...OPTS, timeZone: D })
      expect(formatRecordTime(t, D, OPTS, 'en-IE', D)).toBe(legacy)
      expect(formatRecordTime(t, D, OPTS, 'en-IE', null)).toBe(legacy)
    }
  })
  it('New York record seen from Dublin: New York wall clock + EST/EDT across both 2026 US changes', () => {
    // Sun 8 Mar 2026: 01:59 EST is 06:59Z; 03:00 EDT is 07:00Z.
    expect(formatRecordTime('2026-03-08T06:59:00Z', NY, OPTS, 'en-IE', D)).toBe('8 Mar, 01:59 EST')
    expect(formatRecordTime('2026-03-08T07:00:00Z', NY, OPTS, 'en-IE', D)).toBe('8 Mar, 03:00 EDT')
    // Sun 1 Nov 2026: 01:30 happens twice, EDT then EST.
    expect(formatRecordTime('2026-11-01T05:30:00Z', NY, OPTS, 'en-IE', D)).toBe('1 Nov, 01:30 EDT')
    expect(formatRecordTime('2026-11-01T06:30:00Z', NY, OPTS, 'en-IE', D)).toBe('1 Nov, 01:30 EST')
  })
  it('New York record seen from New York: no suffix', () => {
    expect(formatRecordTime('2026-07-01T13:00:00Z', NY, OPTS, 'en-IE', NY)).toBe('1 Jul, 09:00')
  })
  it('the local day is the record zone\'s, not Dublin\'s', () => {
    // 03:30Z on 1 Jul is still 30 Jun in New York.
    expect(formatRecordTime('2026-07-01T03:30:00Z', NY, { day: 'numeric', month: 'short' }, 'en-IE', NY)).toBe('30 Jun')
    expect(formatRecordTime('2026-07-01T03:30:00Z', D, { day: 'numeric', month: 'short' }, 'en-IE', D)).toBe('1 Jul')
  })
  it('a Dublin record seen from New York carries the Irish abbreviation', () => {
    expect(formatRecordTime('2026-07-01T08:00:00Z', D, OPTS, 'en-IE', NY)).toBe('1 Jul, 09:00 IST')
    expect(formatRecordTime('2026-12-01T09:00:00Z', D, OPTS, 'en-IE', NY)).toBe('1 Dec, 09:00 GMT')
  })
  it('accepts dateStyle options (Intl forbids timeZoneName beside them, so the suffix is appended, not merged)', () => {
    expect(formatRecordTime('2026-07-01T13:00:00Z', NY, { dateStyle: 'medium' }, 'en-IE', D)).toBe('1 Jul 2026 EDT')
  })
  it('never throws: an unparseable instant reads "Invalid Date" as Date#toLocaleString does, an invalid zone floors to Dublin', () => {
    expect(formatRecordTime('garbage', NY, OPTS, 'en-IE', D)).toBe('Invalid Date')
    expect(formatRecordTime('2026-07-01T08:00:00Z', 'Not/AZone', OPTS, 'en-IE', null)).toBe('1 Jul, 09:00')
    expect(formatRecordTime('2026-07-01T08:00:00Z', undefined, OPTS, 'en-IE', null)).toBe('1 Jul, 09:00')
  })
})

describe('zoneCity', () => {
  it('names the zone by its city, as staff copy reads it (Dublin text unchanged)', () => {
    expect(zoneCity(D)).toBe('Dublin')
    expect(zoneCity(NY)).toBe('New York')
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    expect(zoneCity('UTC')).toBe('UTC')
  })
  it('floors an unknown zone to Dublin', () => {
    expect(zoneCity(null)).toBe('Dublin')
    expect(zoneCity('Not/AZone')).toBe('Dublin')
  })
})
