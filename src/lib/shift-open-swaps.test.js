// src/lib/shift-open-swaps.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
const { logWarn } = await import('./log')
const { annotateOwnOpenSwaps, fetchOwnOpenSwaps } = await import('./shift-open-swaps')

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

function mockDb(result) {
  const q = { table: null, select: null, filters: [] }
  const b = {
    select: (c) => { q.select = c; return b },
    eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
    in: (c, v) => { q.filters.push(['in', c, v]); return b },
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return { q, from: (t) => { q.table = t; return b } }
}

describe('fetchOwnOpenSwaps', () => {
  beforeEach(() => logWarn.mockClear())

  it('reads only the caller\'s own OPEN swaps', async () => {
    const db = mockDb({ data: [{ requester_shift_id: 'a1', status: 'pending' }], error: null })
    expect(await fetchOwnOpenSwaps(db, 'me')).toEqual([{ requester_shift_id: 'a1', status: 'pending' }])
    expect(db.q.table).toBe('shift_swap_requests')
    expect(db.q.select).toBe('requester_shift_id, status')
    expect(db.q.filters).toEqual([['eq', 'requester_id', 'me'], ['in', 'status', ['pending', 'awaiting_approval']]])
  })

  it('a failed read is an empty list and a warning: the roster must still load', async () => {
    const db = mockDb({ data: null, error: { message: 'boom' } })
    expect(await fetchOwnOpenSwaps(db, 'me')).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('schedule', expect.any(String), expect.objectContaining({ err: 'boom' }))
  })

  it('no caller id: no query', async () => {
    const db = mockDb({ data: [], error: null })
    expect(await fetchOwnOpenSwaps(db, null)).toEqual([])
    expect(db.q.table).toBeNull()
  })
})
