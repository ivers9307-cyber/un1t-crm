import { describe, it, expect } from 'vitest'
import { naturalSortByName, clampIndex, hasAdvanced } from './presentations'

describe('presentations: naturalSortByName', () => {
  it('orders Slide2 before Slide10 (numeric-aware, not lexicographic)', () => {
    const items = [
      { name: 'Slide10.JPG' }, { name: 'Slide2.JPG' }, { name: 'Slide1.JPG' },
    ]
    expect(naturalSortByName(items).map((i) => i.name))
      .toEqual(['Slide1.JPG', 'Slide2.JPG', 'Slide10.JPG'])
  })
  it('is stable for names that do not sort cleanly', () => {
    const items = [{ name: 'intro' }, { name: 'cover' }, { name: 'intro' }]
    const out = naturalSortByName(items)
    expect(out).toHaveLength(3)
    expect(out.map((i) => i.name).sort()).toEqual(['cover', 'intro', 'intro'])
  })
  it('does not mutate the input array', () => {
    const items = [{ name: 'b' }, { name: 'a' }]
    naturalSortByName(items)
    expect(items.map((i) => i.name)).toEqual(['b', 'a'])
  })
})

describe('presentations: clampIndex', () => {
  it('clamps to [0, count-1]', () => {
    expect(clampIndex(-3, 5)).toBe(0)
    expect(clampIndex(99, 5)).toBe(4)
    expect(clampIndex(2, 5)).toBe(2)
  })
  it('returns 0 for an empty deck or non-finite input', () => {
    expect(clampIndex(0, 0)).toBe(0)
    expect(clampIndex(3, 0)).toBe(0)
    expect(clampIndex(NaN, 5)).toBe(0)
    expect(clampIndex(undefined, 5)).toBe(0)
  })
})

describe('presentations: hasAdvanced', () => {
  it('true only when the version actually changed', () => {
    expect(hasAdvanced(3, 4)).toBe(true)
    expect(hasAdvanced(3, 3)).toBe(false)
    expect(hasAdvanced(null, 0)).toBe(true)   // first load
    expect(hasAdvanced(0, 0)).toBe(false)
  })
})
