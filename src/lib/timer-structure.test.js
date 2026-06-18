import { describe, it, expect } from 'vitest'
import { validateStructure } from './class-timer'
import {
  emptyStructure, newSegment, newRound,
  addBlock, removeBlock, moveBlock, updateBlock,
  addRoundSegment, removeRoundSegment, updateRoundSegment,
} from './timer-structure'

describe('timer-structure: constructors', () => {
  it('emptyStructure / newSegment / newRound are all valid', () => {
    expect(validateStructure(emptyStructure()).ok).toBe(true)
    expect(validateStructure([newSegment()]).ok).toBe(true)
    expect(validateStructure([newRound()]).ok).toBe(true)
  })
  it('overrides merge onto the defaults', () => {
    expect(newSegment({ label: 'Sprint', seconds: 45 })).toMatchObject({ kind: 'segment', label: 'Sprint', seconds: 45 })
    expect(newRound({ count: 8 }).count).toBe(8)
  })
})

describe('timer-structure: block ops (immutable)', () => {
  const base = [newSegment({ label: 'A' }), newSegment({ label: 'B' })]

  it('addBlock appends without mutating', () => {
    const out = addBlock(base, newSegment({ label: 'C' }))
    expect(out.map((b) => b.label)).toEqual(['A', 'B', 'C'])
    expect(base).toHaveLength(2)
  })
  it('removeBlock drops by index', () => {
    expect(removeBlock(base, 0).map((b) => b.label)).toEqual(['B'])
  })
  it('moveBlock swaps and clamps at the ends', () => {
    expect(moveBlock(base, 1, 'up').map((b) => b.label)).toEqual(['B', 'A'])
    expect(moveBlock(base, 0, 'up')).toEqual(base)   // already top → no-op
    expect(moveBlock(base, 1, 'down')).toEqual(base) // already bottom → no-op
  })
  it('updateBlock shallow-merges a patch', () => {
    expect(updateBlock(base, 0, { seconds: 99 })[0]).toMatchObject({ label: 'A', seconds: 99 })
    expect(base[0].seconds).not.toBe(99)
  })
})

describe('timer-structure: round-segment ops', () => {
  const struct = [newRound()] // 2 segments by default

  it('addRoundSegment appends to the round', () => {
    const out = addRoundSegment(struct, 0, { label: 'Burpees', type: 'work', seconds: 20 })
    expect(out[0].segments).toHaveLength(3)
    expect(struct[0].segments).toHaveLength(2)
  })
  it('removeRoundSegment drops by index', () => {
    expect(removeRoundSegment(struct, 0, 1)[0].segments).toHaveLength(1)
  })
  it('updateRoundSegment patches one nested segment', () => {
    const out = updateRoundSegment(struct, 0, 0, { seconds: 50 })
    expect(out[0].segments[0].seconds).toBe(50)
    expect(out[0].segments[1]).toEqual(struct[0].segments[1])
  })
  it('round-segment ops are no-ops on a plain segment block', () => {
    const seg = [newSegment()]
    expect(addRoundSegment(seg, 0, newSegment())).toEqual(seg)
    expect(removeRoundSegment(seg, 0, 0)).toEqual(seg)
    expect(updateRoundSegment(seg, 0, 0, { seconds: 5 })).toEqual(seg)
  })
})
