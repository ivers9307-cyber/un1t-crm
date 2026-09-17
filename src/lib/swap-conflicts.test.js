// SWAPS.2 — findSwapConflicts: the reads it makes, what it does with them,
// and that a failed read becomes a check_failed conflict instead of silence.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
const { logWarn } = await import('./log')
const { findSwapConflicts } = await import('./swap-conflicts')

// A thenable builder per table that records its filters and resolves to the
// configured result.
function mockDb(results) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, select: null, filters: [] }
      queries.push(q)
      const b = {
        select: (cols) => { q.select = cols; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        lte: (c, v) => { q.filters.push(['lte', c, v]); return b },
        gte: (c, v) => { q.filters.push(['gte', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); return b },
        then: (res, rej) => {
          const r = typeof results[table] === 'function' ? results[table](q) : results[table]
          return Promise.resolve(r ?? { data: [], error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}

const block = { id: 'blk-1', block_date: '2099-01-01', start_time: '06:00:00', end_time: '10:00:00' }
const move = { role: 'taker', coachId: 'coach-2', block, leavingAssignmentId: null }
const leaveRow = { id: 't1', profile_id: 'coach-2', type: 'holiday', status: 'approved', start_date: '2099-01-01', end_date: '2099-01-01' }
const clashRow = {
  id: 'a9', profile_id: 'coach-2', block_id: 'blk-9', status: 'scheduled',
  shift_blocks: { id: 'blk-9', block_date: '2099-01-01', start_time: '08:00:00', end_time: '12:00:00', shift_templates: { name: 'Midday' }, locations: { name: 'Hatch' } },
}

beforeEach(() => { logWarn.mockClear() })

describe('findSwapConflicts', () => {
  it('reads approved leave covering the date and that day\'s assignments by PERSON, with no studio filter', async () => {
    const db = mockDb({})
    expect(await findSwapConflicts(db, [move])).toEqual([])
    const leave = db.queries.find((q) => q.table === 'time_off_requests')
    expect(leave.filters).toEqual([
      ['eq', 'profile_id', 'coach-2'], ['eq', 'status', 'approved'],
      ['lte', 'start_date', '2099-01-01'], ['gte', 'end_date', '2099-01-01'],
    ])
    const shifts = db.queries.find((q) => q.table === 'shift_assignments')
    expect(shifts.filters).toEqual([['eq', 'profile_id', 'coach-2'], ['eq', 'shift_blocks.block_date', '2099-01-01']])
    expect(shifts.select).toMatch(/shift_blocks!inner\(/)
    for (const q of db.queries) expect(q.filters.some(([, c]) => c.includes('location_id'))).toBe(false)
    // No conflicts: no names lookup.
    expect(db.queries.some((q) => q.table === 'profiles')).toBe(false)
  })

  it('words a colleague\'s conflicts with their name', async () => {
    const db = mockDb({
      time_off_requests: { data: [leaveRow], error: null },
      shift_assignments: { data: [clashRow], error: null },
      profiles: { data: [{ id: 'coach-2', full_name: 'Cora Coach' }], error: null },
    })
    const out = await findSwapConflicts(db, [move], { viewerId: 'mgr-1' })
    expect(out.map((c) => c.kind)).toEqual(['leave', 'overlap'])
    expect(out[0].message).toBe('Cora Coach has approved holiday on 2099-01-01, which covers the shift on 2099-01-01.')
    expect(out[1].message).toBe('Cora Coach is already on Midday 08:00 to 12:00 at Hatch on 2099-01-01, which overlaps the shift (06:00 to 10:00).')
  })

  it('speaks to the viewer as "You" and skips the names lookup for them', async () => {
    const db = mockDb({ time_off_requests: { data: [leaveRow], error: null } })
    const out = await findSwapConflicts(db, [move], { viewerId: 'coach-2' })
    expect(out[0].message).toMatch(/^You have approved holiday/)
    expect(db.queries.some((q) => q.table === 'profiles')).toBe(false)
  })

  it('a failed read becomes check_failed for that coach, logged, never thrown', async () => {
    const db = mockDb({
      shift_assignments: { data: null, error: { message: 'boom' } },
      profiles: { data: [{ id: 'coach-2', full_name: 'Cora Coach' }], error: null },
    })
    const out = await findSwapConflicts(db, [move], { viewerId: 'mgr-1' })
    expect(out).toEqual([expect.objectContaining({ kind: 'check_failed', coachId: 'coach-2', date: '2099-01-01', message: 'Could not check Cora Coach\'s leave and other shifts for 2099-01-01.' })])
    expect(logWarn).toHaveBeenCalledWith('swaps', 'swap conflict check failed', expect.objectContaining({ coachId: 'coach-2', err: 'boom' }))
  })

  it('a failed names lookup still returns the conflicts, as "This coach"', async () => {
    const db = mockDb({
      time_off_requests: { data: [leaveRow], error: null },
      profiles: { data: null, error: { message: 'nope' } },
    })
    const out = await findSwapConflicts(db, [move], { viewerId: 'mgr-1' })
    expect(out[0].message).toMatch(/^This coach has approved holiday/)
  })

  it('skips moves without a coach or a date, and handles no moves', async () => {
    const db = mockDb({})
    expect(await findSwapConflicts(db, [{ ...move, coachId: null }, { ...move, block: {} }])).toEqual([])
    expect(await findSwapConflicts(db, null)).toEqual([])
    expect(db.queries).toEqual([])
  })
})
