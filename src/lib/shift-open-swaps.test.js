// src/lib/shift-open-swaps.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
const { logWarn } = await import('./log')
const { annotateOwnOpenSwaps, fetchOwnOpenSwaps, ownShiftIds, OWN_SWAP_ID_CHUNK } = await import('./shift-open-swaps')

const rows = [
  { id: 'a1', profile_id: 'me' },
  { id: 'a2', profile_id: 'me' },
  { id: 'a3', profile_id: 'colleague' },
]

describe('annotateOwnOpenSwaps', () => {
  it.each([
    { name: 'a pending swap on my shift', swaps: [{ requester_shift_id: 'a1', status: 'pending' }], expected: ['pending', null, null] },
    { name: 'a claimed swap on my shift', swaps: [{ requester_shift_id: 'a2', status: 'awaiting_approval' }], expected: [null, 'awaiting_approval', null] },
    { name: 'a decided swap is not open', swaps: [{ requester_shift_id: 'a1', status: 'approved' }], expected: [null, null, null] },
    // COACHSCOPE.1 — a swap between colleagues is not the viewer's to see.
    { name: "never a colleague's row, even if a swap names it", swaps: [{ requester_shift_id: 'a3', status: 'pending' }], expected: [null, null, null] },
    { name: 'a swap whose shift was deleted (NULL id)', swaps: [{ requester_shift_id: null, status: 'pending' }], expected: [null, null, null] },
    { name: 'no swaps', swaps: [], expected: [null, null, null] },
    { name: 'an unreadable swap list', swaps: null, expected: [null, null, null] },
  ])('$name', ({ swaps, expected }) => {
    expect(annotateOwnOpenSwaps(rows, swaps, 'me').map((r) => r.open_swap_status)).toEqual(expected)
  })

  it('keeps every other field and does not mutate its input', () => {
    const out = annotateOwnOpenSwaps(rows, [{ requester_shift_id: 'a1', status: 'pending' }], 'me')
    expect(out[0]).toEqual({ id: 'a1', profile_id: 'me', open_swap_status: 'pending' })
    expect(rows[0]).toEqual({ id: 'a1', profile_id: 'me' })
  })

  it('no viewer: every row is null', () => {
    expect(annotateOwnOpenSwaps(rows, [{ requester_shift_id: 'a1', status: 'pending' }], null).map((r) => r.open_swap_status)).toEqual([null, null, null])
  })

  // The Team feed is the same route: a MANAGER reading everyone's rows gets
  // the field on their own shifts only. Other people's swap state reaches a
  // manager through GET /api/schedule/swaps (which has its own review gate),
  // never through this field.
  it("a manager's team feed carries nobody else's swap state", () => {
    const team = [
      { id: 'm1', profile_id: 'manager' },
      { id: 'c1', profile_id: 'coach-a' },
      { id: 'c2', profile_id: 'coach-b' },
    ]
    const swaps = [
      { requester_shift_id: 'm1', status: 'pending' },
      { requester_shift_id: 'c1', status: 'pending' },
      { requester_shift_id: 'c2', status: 'awaiting_approval' },
    ]
    expect(annotateOwnOpenSwaps(team, swaps, 'manager').map((r) => r.open_swap_status)).toEqual(['pending', null, null])
  })
})

// Records EVERY query (the read is chunked), each with its own filters.
function mockDb(result) {
  const queries = []
  return {
    queries,
    get q() { return queries[0] ?? { table: null, select: null, filters: [] } },
    from(t) {
      const q = { table: t, select: null, filters: [] }
      queries.push(q)
      const b = {
        select: (c) => { q.select = c; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); return b },
        then: (res, rej) => Promise.resolve(typeof result === 'function' ? result(q) : result).then(res, rej),
      }
      return b
    },
  }
}

describe('ownShiftIds', () => {
  it("is the caller's own assignment ids in the payload, de-duplicated, nobody else's", () => {
    expect(ownShiftIds([
      { id: 'a1', profile_id: 'me' }, { id: 'a3', profile_id: 'colleague' },
      { id: 'a2', profile_id: 'me' }, { id: 'a1', profile_id: 'me' }, { id: null, profile_id: 'me' },
    ], 'me')).toEqual(['a1', 'a2'])
  })
  it.each([[null, 'me'], [[], 'me'], [rows, null], [rows, 'stranger']])('nothing to ask about: %j / %j', (r, viewer) => {
    expect(ownShiftIds(r, viewer)).toEqual([])
  })
})

describe('fetchOwnOpenSwaps', () => {
  beforeEach(() => logWarn.mockClear())

  it("reads only the caller's own OPEN swaps ON THE SHIFTS IN THIS PAYLOAD", async () => {
    const db = mockDb({ data: [{ requester_shift_id: 'a1', status: 'pending' }], error: null })
    expect(await fetchOwnOpenSwaps(db, 'me', ['a1', 'a2'])).toEqual([{ requester_shift_id: 'a1', status: 'pending' }])
    expect(db.queries).toHaveLength(1)
    expect(db.q.table).toBe('shift_swap_requests')
    expect(db.q.select).toBe('requester_shift_id, status')
    expect(db.q.filters).toEqual([
      ['eq', 'requester_id', 'me'],
      ['in', 'requester_shift_id', ['a1', 'a2']],
      ['in', 'status', ['pending', 'awaiting_approval']],
    ])
  })

  // The phone's most-called feed: a caller with no shift of their own in the
  // window (a manager's Team view, an empty week) costs no query at all.
  it.each([[[]], [null], [undefined]])('no own rows in the payload (%j): no query', async (ids) => {
    const db = mockDb({ data: [{ requester_shift_id: 'a9', status: 'pending' }], error: null })
    expect(await fetchOwnOpenSwaps(db, 'me', ids)).toEqual([])
    expect(db.queries).toHaveLength(0)
  })

  it('a swap on a shift OUTSIDE the payload is never asked for', async () => {
    // A db that honours the filter, holding swaps on a1 (in the window) and
    // z9 (next month): only a1 can come back, because only a1 was asked for.
    const held = [{ requester_shift_id: 'a1', status: 'pending' }, { requester_shift_id: 'z9', status: 'pending' }]
    const db = mockDb((q) => {
      const ids = q.filters.find(([op, col]) => op === 'in' && col === 'requester_shift_id')?.[2] || null
      return { data: ids ? held.filter((h) => ids.includes(h.requester_shift_id)) : held, error: null }
    })
    expect(await fetchOwnOpenSwaps(db, 'me', ['a1'])).toEqual([{ requester_shift_id: 'a1', status: 'pending' }])
  })

  it('bounds every query: a long range is read in chunks, each under the row cap and a sane URL', async () => {
    const ids = Array.from({ length: OWN_SWAP_ID_CHUNK * 2 + 5 }, (_, i) => `a${i}`)
    const db = mockDb((q) => {
      const asked = q.filters.find(([op, col]) => op === 'in' && col === 'requester_shift_id')[2]
      return { data: [{ requester_shift_id: asked[0], status: 'pending' }], error: null }
    })
    const out = await fetchOwnOpenSwaps(db, 'me', ids)
    expect(db.queries).toHaveLength(3)
    for (const q of db.queries) {
      const asked = q.filters.find(([op, col]) => op === 'in' && col === 'requester_shift_id')[2]
      expect(asked.length).toBeLessThanOrEqual(OWN_SWAP_ID_CHUNK)
      expect(q.filters[0]).toEqual(['eq', 'requester_id', 'me'])
    }
    expect(out.map((s) => s.requester_shift_id)).toEqual(['a0', `a${OWN_SWAP_ID_CHUNK}`, `a${OWN_SWAP_ID_CHUNK * 2}`])
  })

  it('a failed read is an empty list and a warning: the roster must still load', async () => {
    const db = mockDb({ data: null, error: { message: 'boom' } })
    expect(await fetchOwnOpenSwaps(db, 'me', ['a1'])).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('schedule', expect.any(String), expect.objectContaining({ err: 'boom' }))
  })

  it('a read that THROWS is fail-soft too', async () => {
    const db = { from() { throw new Error('socket hang up') } }
    expect(await fetchOwnOpenSwaps(db, 'me', ['a1'])).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('schedule', expect.any(String), expect.objectContaining({ err: 'socket hang up' }))
  })

  it('no caller id: no query', async () => {
    const db = mockDb({ data: [], error: null })
    expect(await fetchOwnOpenSwaps(db, null, ['a1'])).toEqual([])
    expect(db.queries).toHaveLength(0)
  })
})
