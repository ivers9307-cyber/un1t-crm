import { describe, it, expect } from 'vitest'
import { pageSlice } from './tv-roll'

describe('pageSlice', () => {
  const items = Array.from({ length: 25 }, (_, i) => i)

  it('25 items / size 8 → 4 pages', () => {
    const { pages } = pageSlice(items, 0, 8)
    expect(pages).toBe(4)
  })

  it('pageIndex 0 → rows 0-7, page 0', () => {
    const { rows, page } = pageSlice(items, 0, 8)
    expect(page).toBe(0)
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('pageIndex 3 → 1 row (item 24), page 3', () => {
    const { rows, page } = pageSlice(items, 3, 8)
    expect(page).toBe(3)
    expect(rows).toEqual([24])
  })

  it('pageIndex 4 wraps → page 0', () => {
    const { rows, page } = pageSlice(items, 4, 8)
    expect(page).toBe(0)
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('negative pageIndex wraps correctly', () => {
    const { page } = pageSlice(items, -1, 8)
    expect(page).toBe(3)
  })

  it('empty list → pages 1, rows []', () => {
    const { rows, page, pages } = pageSlice([], 0, 8)
    expect(pages).toBe(1)
    expect(rows).toEqual([])
    expect(page).toBe(0)
  })

  it('null/undefined list → pages 1, rows []', () => {
    const { rows, pages } = pageSlice(null, 0, 8)
    expect(pages).toBe(1)
    expect(rows).toEqual([])
  })
})
