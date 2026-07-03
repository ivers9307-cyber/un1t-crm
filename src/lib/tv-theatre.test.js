// Tests for tv-theatre.js — pure derivations for the studio-TV theatre.

import { describe, it, expect } from 'vitest'
import {
  roomTotalPoints,
  tileKey,
  stableTileOrder,
  sameOrder,
  zoneWord,
  snapshotSessions,
  detectToastEvents,
  toastDedupeKey,
  selectPodium,
  classDidEnd,
} from './tv-theatre.js'

// Z4+Z5 ≥ 720s → Burn. Helpers to build zones_seconds quickly.
const burnZones = { 4: 600, 5: 200 } // 800s → burn
const noBurnZones = { 4: 300, 5: 100 } // 400s → no burn

function sess(id, { points = 0, zoneId = null, zones = null, name } = {}) {
  return {
    id,
    displayName: name || `Member ${id}`,
    effortPoints: points,
    currentZone: zoneId ? { id: zoneId, label: `Z${zoneId}`, color: '#fff' } : null,
    zonesSeconds: zones,
  }
}

describe('roomTotalPoints', () => {
  it('sums effortPoints across sessions', () => {
    expect(roomTotalPoints([sess('a', { points: 100 }), sess('b', { points: 55 })])).toBe(155)
  })
  it('ignores negative/non-finite/absent points', () => {
    expect(roomTotalPoints([sess('a', { points: 10 }), { id: 'b' }, { id: 'c', effortPoints: -5 }, { id: 'd', effortPoints: NaN }])).toBe(10)
  })
  it('empty / non-array → 0', () => {
    expect(roomTotalPoints([])).toBe(0)
    expect(roomTotalPoints(null)).toBe(0)
  })
})

describe('tileKey', () => {
  it('prefers session id', () => {
    expect(tileKey({ id: 's1', displayName: 'X' })).toBe('id:s1')
  })
  it('falls back to displayName', () => {
    expect(tileKey({ displayName: 'Sarah K.' })).toBe('name:Sarah K.')
  })
})

describe('stableTileOrder', () => {
  it('does NOT reorder by points — position is fixed by first-seen order', () => {
    // b has more points but a was seen first → a stays in slot 0.
    const sessions = [sess('a', { points: 10 }), sess('b', { points: 99 })]
    const { tiles, order } = stableTileOrder(sessions, ['id:a', 'id:b'])
    expect(tiles.map((t) => t._key)).toEqual(['id:a', 'id:b'])
    expect(order).toEqual(['id:a', 'id:b'])
    // …but the RANK badge still reflects points (b is #1).
    expect(tiles.find((t) => t._key === 'id:b')._rank).toBe(1)
    expect(tiles.find((t) => t._key === 'id:a')._rank).toBe(2)
  })

  it('keeps established slots stable when the payload re-sorts by points', () => {
    const prev = ['id:a', 'id:b', 'id:c']
    // Payload arrives sorted by points (c, a, b) — must NOT teleport.
    const payload = [sess('c', { points: 90 }), sess('a', { points: 50 }), sess('b', { points: 10 })]
    const { tiles } = stableTileOrder(payload, prev)
    expect(tiles.map((t) => t._key)).toEqual(['id:a', 'id:b', 'id:c'])
  })

  it('appends new joiners to the end without displacing existing tiles', () => {
    const prev = ['id:a', 'id:b']
    const payload = [sess('b'), sess('a'), sess('c')] // c is new
    const { tiles, order } = stableTileOrder(payload, prev)
    expect(order).toEqual(['id:a', 'id:b', 'id:c'])
    expect(tiles[2]._key).toBe('id:c')
  })

  it('drops keys that left the class', () => {
    const prev = ['id:a', 'id:b', 'id:c']
    const payload = [sess('a'), sess('c')] // b left
    const { order } = stableTileOrder(payload, prev)
    expect(order).toEqual(['id:a', 'id:c'])
  })

  it('handles first render (no prevOrder) using payload order', () => {
    const payload = [sess('x', { points: 5 }), sess('y', { points: 50 })]
    const { order } = stableTileOrder(payload)
    expect(order).toEqual(['id:x', 'id:y'])
  })
})

describe('sameOrder', () => {
  it('true for identical ordered arrays', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
    const x = ['a']
    expect(sameOrder(x, x)).toBe(true)
  })
  it('false for reorders / length change / non-arrays', () => {
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false)
    expect(sameOrder(null, ['a'])).toBe(false)
  })
})

describe('zoneWord', () => {
  it('spells out the zone', () => {
    expect(zoneWord(4)).toBe('Zone 4')
    expect(zoneWord(1)).toBe('Zone 1')
  })
  it('null for out-of-range / missing', () => {
    expect(zoneWord(0)).toBeNull()
    expect(zoneWord(6)).toBeNull()
    expect(zoneWord(null)).toBeNull()
  })
})

describe('detectToastEvents', () => {
  it('fires a redline toast when a member crosses INTO Zone 5', () => {
    const prev = snapshotSessions([sess('a', { zoneId: 4 })])
    const now = [sess('a', { zoneId: 5, name: 'Sarah K.' })]
    const toasts = detectToastEvents(now, prev, new Set())
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ event: 'redline', key: 'id:a' })
    expect(toasts[0].message).toMatch(/Zone 5/)
  })

  it('does NOT re-fire while a member sits in Zone 5 across polls', () => {
    const prev = snapshotSessions([sess('a', { zoneId: 5 })])
    const now = [sess('a', { zoneId: 5 })]
    expect(detectToastEvents(now, prev, new Set())).toHaveLength(0)
  })

  it('does NOT redline on a member whose FIRST reading is Zone 5 (no prior reading)', () => {
    const prev = new Map() // never seen before
    const now = [sess('a', { zoneId: 5 })]
    expect(detectToastEvents(now, prev, new Set())).toHaveLength(0)
  })

  it('respects the already-announced dedupe set', () => {
    const prev = snapshotSessions([sess('a', { zoneId: 4 })])
    const now = [sess('a', { zoneId: 5 })]
    const announced = new Set([toastDedupeKey('id:a', 'redline')])
    expect(detectToastEvents(now, prev, announced)).toHaveLength(0)
  })

  it('fires a burn toast when a member crosses the Burn threshold', () => {
    const prev = snapshotSessions([sess('a', { zones: noBurnZones })])
    const now = [sess('a', { zones: burnZones })]
    const toasts = detectToastEvents(now, prev, new Set())
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ event: 'burn', key: 'id:a' })
  })

  it('does not re-fire a burn once earned', () => {
    const prev = snapshotSessions([sess('a', { zones: burnZones })])
    const now = [sess('a', { zones: burnZones })]
    expect(detectToastEvents(now, prev, new Set())).toHaveLength(0)
  })

  it('redline outranks burn when both cross in the same tick (one per session)', () => {
    const prev = snapshotSessions([sess('a', { zoneId: 4, zones: noBurnZones })])
    const now = [sess('a', { zoneId: 5, zones: burnZones })]
    const toasts = detectToastEvents(now, prev, new Set())
    expect(toasts).toHaveLength(1)
    expect(toasts[0].event).toBe('redline')
  })

  it('empty / non-array is safe', () => {
    expect(detectToastEvents(null, new Map(), new Set())).toEqual([])
  })
})

describe('selectPodium', () => {
  it('returns top-3 by points, placed 1..3', () => {
    const sessions = [
      sess('a', { points: 50 }),
      sess('b', { points: 90 }),
      sess('c', { points: 70 }),
      sess('d', { points: 10 }),
    ]
    const podium = selectPodium(sessions)
    expect(podium.map((p) => p.key)).toEqual(['id:b', 'id:c', 'id:a'])
    expect(podium.map((p) => p.place)).toEqual([1, 2, 3])
  })
  it('excludes zero-point sessions', () => {
    const podium = selectPodium([sess('a', { points: 0 }), sess('b', { points: 5 })])
    expect(podium.map((p) => p.key)).toEqual(['id:b'])
  })
  it('breaks ties deterministically by stable key', () => {
    const podium = selectPodium([sess('b', { points: 10 }), sess('a', { points: 10 })])
    expect(podium.map((p) => p.key)).toEqual(['id:a', 'id:b'])
  })
  it('empty board → empty podium', () => {
    expect(selectPodium([])).toEqual([])
  })
})

describe('classDidEnd', () => {
  it('fires when a live class disappears after having been present', () => {
    expect(classDidEnd({ hadClass: true, currentClass: null, timerFinished: false })).toBe(true)
  })
  it('fires when the timer finishes even if class still present', () => {
    expect(classDidEnd({ hadClass: true, currentClass: { class_name: 'RIDE' }, timerFinished: true })).toBe(true)
  })
  it('does not fire while the class is still live', () => {
    expect(classDidEnd({ hadClass: true, currentClass: { class_name: 'RIDE' }, timerFinished: false })).toBe(false)
  })
  it('does not fire if a class was never seen (no false podium on empty board)', () => {
    expect(classDidEnd({ hadClass: false, currentClass: null, timerFinished: false })).toBe(false)
    expect(classDidEnd({ hadClass: false, currentClass: null, timerFinished: true })).toBe(false)
  })
})
