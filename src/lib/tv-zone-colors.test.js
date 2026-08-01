import { describe, it, expect } from 'vitest'
import {
  ZONE_COLORS_DARK,
  ZONE_WASH_DARK,
  zoneColorDark,
  dominantZone,
} from './tv-zone-colors.js'

const HEX = /^#[0-9A-F]{6}$/i

describe('ZONE_COLORS_DARK / ZONE_WASH_DARK', () => {
  it('cover exactly zones 1..5 with valid hex colours', () => {
    for (const map of [ZONE_COLORS_DARK, ZONE_WASH_DARK]) {
      expect(Object.keys(map).map(Number).sort()).toEqual([1, 2, 3, 4, 5])
      for (const hex of Object.values(map)) expect(hex).toMatch(HEX)
    }
  })

  it('pins the Afterglow spec hexes (Furnace Z4, Redline Z5)', () => {
    expect(ZONE_COLORS_DARK[4]).toBe('#FFA928')
    expect(ZONE_COLORS_DARK[5]).toBe('#FF4E42')
  })
})

describe('zoneColorDark', () => {
  it('returns the palette colour for numeric ids', () => {
    expect(zoneColorDark(1)).toBe(ZONE_COLORS_DARK[1])
    expect(zoneColorDark(3)).toBe('#22C58B')
  })

  it('tolerates string ids', () => {
    expect(zoneColorDark('4')).toBe('#FFA928')
  })

  it('returns null for unknown ids', () => {
    expect(zoneColorDark(0)).toBeNull()
    expect(zoneColorDark(6)).toBeNull()
    expect(zoneColorDark('nope')).toBeNull()
    expect(zoneColorDark(null)).toBeNull()
    expect(zoneColorDark(undefined)).toBeNull()
  })
})

describe('dominantZone', () => {
  it('returns the most common zone id (flat zoneId shape)', () => {
    const sessions = [
      { zoneId: 3 },
      { zoneId: 3 },
      { zoneId: 3 },
      { zoneId: 5 },
    ]
    expect(dominantZone(sessions)).toBe(3)
  })

  it('reads the nested currentZone.id shape too', () => {
    const sessions = [
      { currentZone: { id: 2 } },
      { currentZone: { id: 2 } },
      { zoneId: 4 },
    ]
    expect(dominantZone(sessions)).toBe(2)
  })

  it('resolves ties to the higher zone', () => {
    const sessions = [{ zoneId: 2 }, { zoneId: 4 }, { zoneId: 2 }, { zoneId: 4 }]
    expect(dominantZone(sessions)).toBe(4)
  })

  it('returns null when empty or nullish', () => {
    expect(dominantZone([])).toBeNull()
    expect(dominantZone(null)).toBeNull()
    expect(dominantZone(undefined)).toBeNull()
  })

  it('skips sessions with missing or invalid zone ids', () => {
    const sessions = [
      {},
      { zoneId: null },
      { zoneId: 0 },
      { zoneId: 9 },
      { currentZone: {} },
      { zoneId: 5 },
    ]
    expect(dominantZone(sessions)).toBe(5)
    expect(dominantZone([{}, { zoneId: 'x' }])).toBeNull()
  })

  it('tolerates string zone ids', () => {
    expect(dominantZone([{ zoneId: '3' }, { currentZone: { id: '3' } }, { zoneId: 1 }])).toBe(3)
  })
})
