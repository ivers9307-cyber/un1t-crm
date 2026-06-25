import { describe, it, expect } from 'vitest'
import { selectAll, selectAllByKeys } from './select-all.js'

// A mock buildQuery backed by a flat array. Records every (from, to) it was
// called with so we can assert the pagination math, and slices the source the
// way PostgREST `.range(from, to)` does (inclusive bounds, capped at pageSize).
function makeBuilder(source, { error = null } = {}) {
  const calls = []
  const buildQuery = async (from, to) => {
    calls.push([from, to])
    if (error) return { data: null, error }
    // PostgREST range is inclusive; the server also never returns more than
    // db-max-rows even if `to - from + 1` asks for more, so honour both.
    return { data: source.slice(from, to + 1), error: null }
  }
  return { buildQuery, calls }
}

describe('selectAll', () => {
  it('returns every row across multiple pages, concatenated in order', async () => {
    const source = Array.from({ length: 2500 }, (_, i) => ({ id: i }))
    const { buildQuery, calls } = makeBuilder(source)

    const rows = await selectAll(buildQuery, { pageSize: 1000 })

    expect(rows).toHaveLength(2500)
    expect(rows[0]).toEqual({ id: 0 })
    expect(rows[2499]).toEqual({ id: 2499 })
    // Page ranges: [0,999], [1000,1999], [2000,2999]. The third page returns
    // 500 (< pageSize) so the loop stops — no fourth call.
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops after a single page when the first page is short', async () => {
    const source = Array.from({ length: 42 }, (_, i) => ({ id: i }))
    const { buildQuery, calls } = makeBuilder(source)

    const rows = await selectAll(buildQuery, { pageSize: 1000 })

    expect(rows).toHaveLength(42)
    expect(calls).toEqual([[0, 999]])
  })

  it('stops cleanly when the data is exactly a multiple of pageSize', async () => {
    // 2000 rows / pageSize 1000 = two full pages, then an empty third page
    // tells the loop it has run out (a full final page can't be distinguished
    // from "more to come" without one more fetch).
    const source = Array.from({ length: 2000 }, (_, i) => ({ id: i }))
    const { buildQuery, calls } = makeBuilder(source)

    const rows = await selectAll(buildQuery, { pageSize: 1000 })

    expect(rows).toHaveLength(2000)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('returns an empty array when there are no rows', async () => {
    const { buildQuery, calls } = makeBuilder([])

    const rows = await selectAll(buildQuery, { pageSize: 1000 })

    expect(rows).toEqual([])
    expect(calls).toEqual([[0, 999]])
  })

  it('stops at hardCap and clamps the final range to the cap', async () => {
    const source = Array.from({ length: 10000 }, (_, i) => ({ id: i }))
    const { buildQuery, calls } = makeBuilder(source)

    // pageSize 1000, hardCap 2500 → pages [0,999], [1000,1999], then the third
    // page is clamped to end at hardCap-1 = 2499. After it the accumulated
    // count (2500) >= hardCap so the loop stops without over-reading.
    const rows = await selectAll(buildQuery, { pageSize: 1000, hardCap: 2500 })

    expect(rows).toHaveLength(2500)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2499]])
  })

  it('uses a custom pageSize for the range math', async () => {
    const source = Array.from({ length: 7 }, (_, i) => ({ id: i }))
    const { buildQuery, calls } = makeBuilder(source)

    const rows = await selectAll(buildQuery, { pageSize: 3 })

    expect(rows).toHaveLength(7)
    // [0,2]=3, [3,5]=3, [6,8]=1 (short) → stop.
    expect(calls).toEqual([[0, 2], [3, 5], [6, 8]])
  })

  it('throws on a page error', async () => {
    const { buildQuery } = makeBuilder([], { error: { message: 'boom' } })
    await expect(selectAll(buildQuery)).rejects.toThrow('boom')
  })
})

describe('selectAllByKeys', () => {
  it('chunks the key list and unions matches across chunks', async () => {
    // 700 keys, chunkSize 300 → 3 chunks (300, 300, 100). Backing store maps
    // each key to one row; assert every key's row comes back and the key list
    // was split into the expected chunk sizes.
    const keys = Array.from({ length: 700 }, (_, i) => `k${i}`)
    const store = new Map(keys.map(k => [k, { key: k }]))
    const chunkSizes = []
    const buildQuery = async (chunk, from, to) => {
      chunkSizes.push(chunk.length)
      const rows = chunk.map(k => store.get(k)).filter(Boolean)
      return { data: rows.slice(from, to + 1), error: null }
    }

    const rows = await selectAllByKeys(keys, buildQuery, { chunkSize: 300 })

    expect(rows).toHaveLength(700)
    expect(new Set(rows.map(r => r.key)).size).toBe(700)
    expect(chunkSizes).toEqual([300, 300, 100])
  })

  it('pages WITHIN a chunk when one chunk has >pageSize matches', async () => {
    // A single chunk of 5 keys, but each key fans out to many rows so the
    // chunk's match set exceeds pageSize — must page inside the chunk.
    const keys = ['a', 'b', 'c', 'd', 'e']
    const allRows = Array.from({ length: 2300 }, (_, i) => ({ id: i }))
    const ranges = []
    const buildQuery = async (_chunk, from, to) => {
      ranges.push([from, to])
      return { data: allRows.slice(from, to + 1), error: null }
    }

    const rows = await selectAllByKeys(keys, buildQuery, { chunkSize: 300, pageSize: 1000 })

    expect(rows).toHaveLength(2300)
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('returns an empty array for no keys', async () => {
    let called = false
    const buildQuery = async () => { called = true; return { data: [], error: null } }
    const rows = await selectAllByKeys([], buildQuery)
    expect(rows).toEqual([])
    expect(called).toBe(false)
  })
})
