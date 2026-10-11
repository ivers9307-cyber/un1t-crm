// shared/zone-suffix.test.js — the ONE "name the zone only when it is not the
// viewer's" rule (D3 = A) that src/lib/record-time.js (web) and
// mobile/lib/studio-zone.js (phone) both use. Their own suites
// (src/lib/record-time.test.js, mobile/lib/studio-zone.tz.test.js) pin the
// rendered text; this file pins the shared contract and its Hermes safety.
process.env.TZ = 'America/Los_Angeles' // neither zone under test: nothing may read the host clock
import { describe, it, expect, vi } from 'vitest'

const D = 'Europe/Dublin'
const NY = 'America/New_York'

describe('importing builds no Intl formatter (Hermes-safe)', () => {
  it('module evaluation never constructs Intl.DateTimeFormat', async () => {
    vi.resetModules()
    const spy = vi.spyOn(Intl, 'DateTimeFormat')
    await import('./zone-suffix.js?import-probe')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

const Z = await import('./zone-suffix.js')

describe('sameZone', () => {
  it('compares through canonicalZone and is false for an invalid side', () => {
    expect(Z.sameZone('Asia/Kolkata', 'Asia/Calcutta')).toBe(true)
    expect(Z.sameZone('europe/dublin', D)).toBe(true)
    expect(Z.sameZone(NY, D)).toBe(false)
    expect(Z.sameZone(null, null)).toBe(false)
    expect(Z.sameZone('Not/AZone', 'Not/AZone')).toBe(false)
  })
})

describe('zoneSuffix', () => {
  it('is empty for the same zone, an unknown viewer, or an unparseable instant', () => {
    expect(Z.zoneSuffix('2026-07-15T13:00:00Z', NY, NY)).toBe('')
    expect(Z.zoneSuffix('2026-07-15T13:00:00Z', NY, null)).toBe('')
    expect(Z.zoneSuffix('2026-07-15T13:00:00Z', NY, 'Not/AZone')).toBe('')
    expect(Z.zoneSuffix('nope', NY, D)).toBe('')
  })
  it('names the record zone across both 2026 DST changes in each direction', () => {
    expect(Z.zoneSuffix('2026-03-08T06:59:00Z', NY, D)).toBe(' EST')
    expect(Z.zoneSuffix('2026-03-08T07:00:00Z', NY, D)).toBe(' EDT')
    expect(Z.zoneSuffix('2026-03-29T00:59:00Z', D, NY)).toBe(' GMT')
    expect(Z.zoneSuffix('2026-03-29T01:00:00Z', D, NY)).toBe(' IST')
    expect(Z.zoneSuffix('2026-10-25T00:59:00Z', D, NY)).toBe(' IST')
    expect(Z.zoneSuffix('2026-10-25T01:00:00Z', D, NY)).toBe(' GMT')
  })
  it('an unresolvable record zone is the Dublin floor', () => {
    expect(Z.zoneSuffix('2026-07-15T08:00:00Z', 'Not/AZone', D)).toBe('')
    expect(Z.zoneSuffix('2026-07-15T08:00:00Z', 'Not/AZone', NY)).toBe(' IST')
  })
})

describe('zoneAbbreviation', () => {
  it('lettered abbreviation first, else the offset form', () => {
    expect(Z.zoneAbbreviation('2026-07-15T08:00:00Z', 'Europe/London')).toBe('BST')
    expect(Z.zoneAbbreviation('2026-07-15T08:00:00Z', 'Asia/Tokyo')).toBe('GMT+9')
    expect(Z.zoneAbbreviation('2026-07-15T08:00:00Z', 'Asia/Kolkata')).toBe('GMT+5:30')
  })
  it('never empty for a real instant: every IANA zone, Jan and Jul 2026', () => {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [D, NY]
    for (const z of zones) {
      for (const iso of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z']) {
        expect(Z.zoneAbbreviation(iso, z), z).not.toBe('')
      }
    }
  })
})
