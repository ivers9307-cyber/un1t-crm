import { describe, it, expect } from 'vitest'
import { summariseBoardDryRun } from './pipeline-board-dry-run'

const board = {
  key: 'o_sale',
  stages: [
    { slug: 'b', name: 'Second', display_order: 2 },
    { slug: 'a', name: 'First', display_order: 1 },
    { slug: 'c', name: 'Third', display_order: 3 },
  ],
}

describe('summariseBoardDryRun', () => {
  it('summarisesStagesInOrderWithZeros', () => {
    const s = summariseBoardDryRun({
      board_histogram: { o_sale: 7 }, stage_histogram: { a: 5, b: 2 }, contacts_seen: 100, errors: [],
    }, board)
    expect(s.entering).toBe(7)
    expect(s.byStage).toEqual([
      { slug: 'a', name: 'First', count: 5 },
      { slug: 'b', name: 'Second', count: 2 },
      { slug: 'c', name: 'Third', count: 0 },
    ])
    expect(s.contactsSeen).toBe(100)
    expect(summariseBoardDryRun({}, board).entering).toBe(0)
  })

  it('summarisesOverlapByBoard', () => {
    const s = summariseBoardDryRun({
      board_overlap: { o_sale: { cold: 3, acquisition: 9 }, other: { x: 1 } },
    }, board, { acquisition: 'Acquisition' })
    expect(s.overlap).toEqual([
      { boardKey: 'acquisition', boardName: 'Acquisition', count: 9 },
      { boardKey: 'cold', count: 3 },
    ])
  })
})
