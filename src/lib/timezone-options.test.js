// TZ.2 — the location timezone picker's data and the D8 country hint.
process.env.TZ = 'America/Los_Angeles' // neither zone under test: nothing may read the host clock
import { describe, it, expect } from 'vitest'
import {
  COMMON_ZONES, COUNTRY_OPTIONS, allZones, countryZoneMismatch, browserZone, zoneOffsetLabel, filterZones,
} from './timezone-options.js'
import { canonicalZone } from '@shared/zoned-time'


describe('allZones', () => {
  it('starts with COMMON_ZONES, in order, then the rest, with no duplicates', () => {
    const all = allZones()
    expect(all.slice(0, COMMON_ZONES.length)).toEqual([...COMMON_ZONES])
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBeGreaterThan(300)
  })
  it('every entry is a zone canonicalZone accepts, spelled as canonicalZone spells it', () => {
    for (const z of allZones()) expect(canonicalZone(z)).toBe(z)
  })
  it('the common zones keep the old 12-zone list and add the US four', () => {
    for (const z of ['Europe/Dublin', 'Europe/London', 'Europe/Berlin', 'Europe/Malta', 'Asia/Nicosia', 'Africa/Cairo',
      'Asia/Kuwait', 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide',
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']) expect(COMMON_ZONES).toContain(z)
  })
  it('lists no fixed offsets and no Etc/ zones', () => {
    expect(allZones().filter((z) => /^Etc\/|GMT[+-]|UTC[+-]|^[+-]\d/.test(z))).toEqual([])
  })
})

describe('countryZoneMismatch (D8: a warning, never a block)', () => {
  it('warns for country AU on Europe/Dublin', () => {
    expect(countryZoneMismatch('AU', 'Europe/Dublin')).toBe('Country is AU but the timezone is Europe/Dublin. Is that right?')
  })
  it.each([['AU', 'Australia/Perth'], ['IE', 'Europe/Dublin'], ['GB', 'Europe/London'], ['US', 'America/New_York'],
    ['US', 'Pacific/Honolulu'], ['ie', 'Europe/Dublin'], ['CY', 'Asia/Famagusta']])('%s + %s: no warning', (c, z) => {
    expect(countryZoneMismatch(c, z)).toBeNull()
  })
  it.each([['IE', 'Europe/London'], ['GB', 'Europe/Dublin'], ['US', 'Europe/Dublin'], ['DE', 'America/New_York']])('%s + %s: warns', (c, z) => {
    expect(countryZoneMismatch(c, z)).toMatch(/^Country is .+ but the timezone is .+\. Is that right\?$/)
  })
  it('stays silent for a country it has no table for, an invalid zone, or no country', () => {
    expect(countryZoneMismatch('FR', 'Asia/Tokyo')).toBeNull()
    expect(countryZoneMismatch('AU', 'Mars/Olympus')).toBeNull()
    expect(countryZoneMismatch('', 'Europe/Dublin')).toBeNull()
    expect(countryZoneMismatch(null, 'Europe/Dublin')).toBeNull()
  })
  it('has a zone table for every country the forms offer', () => {
    for (const { code } of COUNTRY_OPTIONS) {
      expect(countryZoneMismatch(code, 'Antarctica/Troll'), code).not.toBeNull()
    }
  })
})

describe('browserZone', () => {
  it('is the runtime zone, canonicalised', () => {
    expect(browserZone('Asia/Kolkata')).toBe(canonicalZone('Asia/Kolkata'))
    expect(browserZone('america/new_york')).toBe('America/New_York')
  })
  it.each(['UTC', 'Etc/UTC', 'Etc/Unknown', '', undefined, null])('is null for %j (no real signal: never pre-fill a gym with UTC)', (tz) => {
    expect(browserZone(tz ?? null)).toBeNull()
  })
  it('reads the runtime (host) zone when called bare', () => {
    // This file pins the host to America/Los_Angeles.
    expect(browserZone()).toBe('America/Los_Angeles')
  })
})

describe('zoneOffsetLabel (the picker shows the CURRENT offset)', () => {
  it('Europe/Dublin: GMT+0 in winter, GMT+1 in summer (EU change 29 Mar / 25 Oct 2026)', () => {
    expect(zoneOffsetLabel('Europe/Dublin', Date.parse('2026-03-29T00:59:00Z'))).toBe('GMT+0')
    expect(zoneOffsetLabel('Europe/Dublin', Date.parse('2026-03-29T01:00:00Z'))).toBe('GMT+1')
    expect(zoneOffsetLabel('Europe/Dublin', Date.parse('2026-10-25T00:59:00Z'))).toBe('GMT+1')
    expect(zoneOffsetLabel('Europe/Dublin', Date.parse('2026-10-25T01:00:00Z'))).toBe('GMT+0')
  })
  it('America/New_York follows New York across its DST change (8 Mar / 1 Nov 2026)', () => {
    expect(zoneOffsetLabel('America/New_York', Date.parse('2026-03-08T06:59:00Z'))).toBe('GMT-5')
    expect(zoneOffsetLabel('America/New_York', Date.parse('2026-03-08T07:00:00Z'))).toBe('GMT-4')
    expect(zoneOffsetLabel('America/New_York', Date.parse('2026-11-01T05:59:00Z'))).toBe('GMT-4')
    expect(zoneOffsetLabel('America/New_York', Date.parse('2026-11-01T06:00:00Z'))).toBe('GMT-5')
  })
  it('half-hour zones and an invalid zone', () => {
    expect(zoneOffsetLabel('Asia/Kolkata', Date.parse('2026-06-01T00:00:00Z'))).toBe('GMT+5:30')
    expect(zoneOffsetLabel('Mars/Olympus', 0)).toBe('')
  })
})

describe('filterZones', () => {
  const zones = allZones()
  it('"york" finds America/New_York', () => {
    expect(filterZones(zones, 'york')).toEqual(['America/New_York'])
  })
  it('matches a space against the underscore, case-insensitively', () => {
    expect(filterZones(zones, 'NEW YORK')).toEqual(['America/New_York'])
    expect(filterZones(zones, 'los ang')).toEqual(['America/Los_Angeles'])
  })
  it('an empty query returns every zone, in order', () => {
    expect(filterZones(zones, '  ')).toBe(zones)
  })
})
