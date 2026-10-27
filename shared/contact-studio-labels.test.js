import { describe, it, expect } from 'vitest'
import { studioTagNames, studioTagFor } from './contact-studio-labels.js'

const HATCH = { location_id: 'h', location: { name: 'UN1T Hatch Street' } }
const STILL = { location_id: 's', location: { name: 'UN1T Stillorgan' } }

describe('studioTagNames', () => {
  it('one studio → no tags', () => {
    expect(studioTagNames([STILL])).toEqual({})
    expect(studioTagNames([])).toEqual({})
    expect(studioTagNames(null)).toEqual({})
  })
  it('two studios sharing a brand word → short names', () => {
    expect(studioTagNames([STILL, HATCH])).toEqual({ s: 'Stillorgan', h: 'Hatch Street' })
  })
  it('names that share no first word stay whole', () => {
    expect(studioTagNames([HATCH, { location_id: 'c', location: { name: 'CCF Autos' } }]))
      .toEqual({ h: 'UN1T Hatch Street', c: 'CCF Autos' })
  })
  it('a row with no location name is skipped, and a duplicate studio counts once', () => {
    expect(studioTagNames([STILL, STILL, { location_id: 'x', location: null }])).toEqual({})
  })
})

describe('studioTagFor', () => {
  const tags = studioTagNames([STILL, HATCH])
  it('names a known studio', () => expect(studioTagFor(tags, 'h')).toBe('Hatch Street'))
  it('null for an unknown studio, no location, or no tags', () => {
    expect(studioTagFor(tags, 'zzz')).toBeNull()
    expect(studioTagFor(tags, null)).toBeNull()
    expect(studioTagFor({}, 'h')).toBeNull()
    expect(studioTagFor(undefined, 'h')).toBeNull()
  })
})
