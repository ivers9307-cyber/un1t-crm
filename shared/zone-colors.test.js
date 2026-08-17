import { describe, it, expect } from 'vitest'
import { ZONE_COLORS_DARK, zoneColorDark } from './zone-colors'
import { ZONE_DEFS } from './heart-rate'

describe('zone-colors', () => {
  it('defines a dark-canvas colour for all five canonical zones', () => {
    expect(Object.keys(ZONE_COLORS_DARK).map(Number).sort()).toEqual([1, 2, 3, 4, 5])
    expect(ZONE_COLORS_DARK[4]).toBe('#FFA928') // Furnace — also the Burn colour
  })

  it('zoneColorDark returns the dark shade for known zones', () => {
    expect(zoneColorDark(5)).toBe('#FF4E42')
    expect(zoneColorDark('2')).toBe('#4D9FFF') // string ids tolerated
  })

  it('returns null for unknown zones and never mutates the canonical set', () => {
    expect(zoneColorDark(99)).toBe(null)
    // canonical set untouched — the dark palette is a VIEW, not a mutation
    expect(ZONE_DEFS[3].color).toBe('#F59E0B')
  })
})
