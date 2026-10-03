// SHIFTTPL.1 / SHIFTMIN-CLAMP.1 — the block-side effects of a template edit.

import { describe, it, expect } from 'vitest'
import { clearEmptyFutureBlocks, planBlockCapacityUpdates, readFutureBlocksForTemplate } from './shift-template-blocks'

describe('planBlockCapacityUpdates', () => {
  const blocks = [
    { id: 'roomy', min_coaches: 1, max_coaches: 10 },
    { id: 'tight', min_coaches: 1, max_coaches: 2 },
    { id: 'tighter', min_coaches: 1, max_coaches: 1 },
  ]

  // THE BUG: one statement writing min 3 onto every block fails the whole
  // statement on `tight` and `tighter`, so NONE of them move.
  it('clamps the minimum at each block’s own ceiling, in groups', () => {
    const groups = planBlockCapacityUpdates(blocks, { minCoaches: 3 })
    expect(groups).toEqual([
      { patch: { min_coaches: 3 }, expect: { min_coaches: 1, max_coaches: 10 }, ids: ['roomy'] },
      { patch: { min_coaches: 2 }, expect: { min_coaches: 1, max_coaches: 2 }, ids: ['tight'] },
      // `tighter` clamps to 1, which it already is, so it is not written.
    ])
  })

  it('groups blocks that land on the same clamped value into ONE statement', () => {
    const groups = planBlockCapacityUpdates(
      [{ id: 'a', min_coaches: 1, max_coaches: 2 }, { id: 'b', min_coaches: 1, max_coaches: 2 }],
      { minCoaches: 5 },
    )
    expect(groups).toEqual([{ patch: { min_coaches: 2 }, expect: { min_coaches: 1, max_coaches: 2 }, ids: ['a', 'b'] }])
  })

  it('never writes a block whose value already matches', () => {
    expect(planBlockCapacityUpdates([{ id: 'a', min_coaches: 2, max_coaches: 2 }], { minCoaches: 5 })).toEqual([])
    expect(planBlockCapacityUpdates([{ id: 'a', min_coaches: 1, max_coaches: 10 }], { maxCoaches: 10 })).toEqual([])
  })

  // The same CHECK, from the other side: min 3 against a new max of 2.
  it('drags a block’s minimum down when the maximum is lowered under it, in one patch', () => {
    expect(planBlockCapacityUpdates([{ id: 'a', min_coaches: 3, max_coaches: 10 }], { maxCoaches: 2 }))
      .toEqual([{ patch: { max_coaches: 2, min_coaches: 2 }, expect: { min_coaches: 3, max_coaches: 10 }, ids: ['a'] }])
  })

  it('applies both at once when both are edited', () => {
    expect(planBlockCapacityUpdates([{ id: 'a', min_coaches: 1, max_coaches: 10 }], { minCoaches: 4, maxCoaches: 3 }))
      .toEqual([{ patch: { max_coaches: 3, min_coaches: 3 }, expect: { min_coaches: 1, max_coaches: 10 }, ids: ['a'] }])
  })

  // BLOCKEDIT.1 third check 2 — each group carries the values its blocks were
  // READ with, and blocks read differently never share a statement, so the
  // write can be guarded on them.
  it('splits blocks that land on the same patch but were read with different values', () => {
    const groups = planBlockCapacityUpdates(
      [{ id: 'a', min_coaches: 1, max_coaches: 10 }, { id: 'b', min_coaches: 2, max_coaches: 10 }],
      { maxCoaches: 8 },
    )
    expect(groups).toEqual([
      { patch: { max_coaches: 8 }, expect: { min_coaches: 1, max_coaches: 10 }, ids: ['a'] },
      { patch: { max_coaches: 8 }, expect: { min_coaches: 2, max_coaches: 10 }, ids: ['b'] },
    ])
  })

  it('plans nothing when neither is being edited', () => {
    expect(planBlockCapacityUpdates(blocks, {})).toEqual([])
    expect(planBlockCapacityUpdates(null, { minCoaches: 2 })).toEqual([])
  })
})

describe('clearEmptyFutureBlocks', () => {
  function mockDb({ readError = null, deleteError = null, rows = null } = {}) {
    const calls = { deletedIds: null, read: false }
    const db = {
      from() {
        const chain = {
          select: () => chain,
          delete: () => { chain._delete = true; return chain },
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          range: () => chain,
          in: (_c, ids) => { calls.deletedIds = ids; return chain },
          then: (onF, onR) => {
            if (chain._delete) return Promise.resolve({ data: null, error: deleteError }).then(onF, onR)
            calls.read = true
            return Promise.resolve({ data: rows, error: readError }).then(onF, onR)
          },
        }
        return chain
      },
    }
    return { db, calls }
  }

  const ARGS = { templateId: 't1', locationId: 'loc1', today: '2026-09-17' }

  it('deletes the empty unpublished blocks and keeps the published empties', async () => {
    const { db, calls } = mockDb()
    const res = await clearEmptyFutureBlocks(db, {
      ...ARGS,
      blocks: [
        { id: 'b1', rosters: null, shift_assignments: [] },
        { id: 'b2', rosters: { status: 'published' }, shift_assignments: [] },
        { id: 'b3', rosters: null, shift_assignments: [{ profile_id: 'p', status: 'scheduled' }] },
      ],
    })
    expect(res).toEqual({ deleted: 1, publishedEmptiesKept: 1, error: null })
    expect(calls.deletedIds).toEqual(['b1'])
  })

  it('treats a cancelled assignment as empty (nobody is working it)', async () => {
    const { db, calls } = mockDb()
    const res = await clearEmptyFutureBlocks(db, {
      ...ARGS,
      blocks: [{ id: 'b1', rosters: null, shift_assignments: [{ profile_id: 'p', status: 'cancelled' }] }],
    })
    expect(res.deleted).toBe(1)
    expect(calls.deletedIds).toEqual(['b1'])
  })

  it('reads the blocks itself when the caller has not', async () => {
    const { db, calls } = mockDb({ rows: [{ id: 'b1', rosters: null, shift_assignments: [] }] })
    const res = await clearEmptyFutureBlocks(db, ARGS)
    expect(calls.read).toBe(true)
    expect(res.deleted).toBe(1)
  })

  // A failed read reading as "nothing to clear" is the silent no-op this
  // helper exists to remove.
  it('surfaces a failed read instead of reporting a clean sweep', async () => {
    const { db } = mockDb({ readError: { message: 'boom' } })
    const res = await clearEmptyFutureBlocks(db, ARGS)
    expect(res.deleted).toBe(0)
    expect(res.error).toEqual({ message: 'boom' })
  })

  it('surfaces a failed delete', async () => {
    const { db } = mockDb({ deleteError: { message: 'deadlock' } })
    const res = await clearEmptyFutureBlocks(db, {
      ...ARGS, blocks: [{ id: 'b1', rosters: null, shift_assignments: [] }],
    })
    expect(res.deleted).toBe(0)
    expect(res.error).toEqual({ message: 'deadlock' })
  })

  it('writes nothing when there is nothing to clear', async () => {
    const { db, calls } = mockDb()
    const res = await clearEmptyFutureBlocks(db, { ...ARGS, blocks: [] })
    expect(res).toEqual({ deleted: 0, publishedEmptiesKept: 0, error: null })
    expect(calls.deletedIds).toBeNull()
  })
})

// ROSTERTIDY.1 — the read feeds the template-minimum propagation and the
// deactivate clean-up. Unpaged, a horizon past 1,000 blocks would silently
// act on only the first page.
describe('readFutureBlocksForTemplate', () => {
  // A mock that honours .range() the way PostgREST does: never more than the
  // window asked for, and never more than 1,000 whatever the window.
  function pagedDb(rows, { failOnPage = null } = {}) {
    const ranges = []
    const orders = []
    const db = {
      from(table) {
        expect(table).toBe('shift_blocks')
        const f = { from: 0, to: Infinity }
        const chain = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          order: (col) => { orders.push(col); return chain },
          range: (from, to) => { f.from = from; f.to = to; ranges.push([from, to]); return chain },
          then: (onF, onR) => {
            if (failOnPage != null && ranges.length - 1 === failOnPage) {
              return Promise.resolve({ data: null, error: { message: 'page failed' } }).then(onF, onR)
            }
            const end = Math.min(f.to + 1, f.from + 1000)
            return Promise.resolve({ data: rows.slice(f.from, end), error: null }).then(onF, onR)
          },
        }
        return chain
      },
    }
    return { db, ranges, orders }
  }

  const ARGS = { templateId: 't1', locationId: 'loc1', today: '2026-09-17' }
  const rows = Array.from({ length: 2345 }, (_, i) => ({ id: `b${String(i).padStart(5, '0')}` }))

  it('reads every page past the 1,000-row cap', async () => {
    const { db, ranges, orders } = pagedDb(rows)
    const res = await readFutureBlocksForTemplate(db, ARGS)
    expect(res.error).toBeNull()
    expect(res.blocks).toHaveLength(2345)
    expect(res.blocks.at(-1).id).toBe('b02344')
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    // A stable order is what makes the pages disjoint.
    expect(orders.slice(0, 2)).toEqual(['block_date', 'id'])
  })

  it('stops after one read when the first page is short', async () => {
    const { db, ranges } = pagedDb(rows.slice(0, 56))
    const res = await readFutureBlocksForTemplate(db, ARGS)
    expect(res.blocks).toHaveLength(56)
    expect(ranges).toHaveLength(1)
  })

  it('reads one extra empty page when the total is an exact multiple of the page size', async () => {
    const { db, ranges } = pagedDb(rows.slice(0, 1000))
    const res = await readFutureBlocksForTemplate(db, ARGS)
    expect(res.blocks).toHaveLength(1000)
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
  })

  // A partial list would read as "these are all the future blocks".
  it('returns the error and NO blocks when a later page fails', async () => {
    const { db } = pagedDb(rows, { failOnPage: 1 })
    const res = await readFutureBlocksForTemplate(db, ARGS)
    expect(res.blocks).toEqual([])
    expect(res.error).toEqual({ message: 'page failed' })
  })
})
