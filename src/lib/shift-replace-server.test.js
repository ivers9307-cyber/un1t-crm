// src/lib/shift-replace-server.test.js
// REPLACE.1a — the reads and the one guarded move behind POST /replace.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptedDb, chainsFor, argsOf, allArgsOf } from './scripted-db.test-helpers'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { logError } = await import('./log')
const { readReplaceContext, replaceShiftAssignment } = await import('./shift-replace-server')

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  rosters: { status: 'published' }, shift_templates: { name: 'Morning' }, locations: { name: 'Studio North', timezone: 'Europe/Dublin' },
}
const A_ROW = { id: 'as-1', profile_id: 'coach-a', block_id: 'b1', status: 'scheduled', arrived_at: null, start_time_override: null, profiles: { full_name: 'Coach A' }, shift_blocks: BLOCK }

beforeEach(() => vi.clearAllMocks())

describe('readReplaceContext', () => {
  it('reads the assignment, then B only as a MEMBER, then who is live on the block', async () => {
    const db = scriptedDb({
      shift_assignments: [
        { data: A_ROW, error: null },
        { data: [{ id: 'as-1', profile_id: 'coach-a', status: 'scheduled' }, { id: 'as-0', profile_id: 'coach-c', status: 'cancelled' }], error: null },
      ],
      profile_locations: [{ data: [{ profile_id: 'coach-b' }], error: null }],
      profiles: [{ data: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null }, error: null }],
    })
    const ctx = await readReplaceContext(db, { assignmentId: 'as-1', toProfileId: 'coach-b' })
    expect(ctx).toEqual({
      error: null,
      assignment: A_ROW,
      block: BLOCK,
      toIsMember: true,
      toProfile: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null },
      liveOnBlockIds: ['coach-a'],
    })
    const [pl] = chainsFor(db, 'profile_locations')
    expect(allArgsOf(pl, 'eq')).toEqual([['location_id', 'loc-1'], ['profile_id', 'coach-b']])
  })

  it('a non-member\'s profile is never read', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: A_ROW, error: null }, { data: [], error: null }],
      profile_locations: [{ data: [], error: null }],
    })
    const ctx = await readReplaceContext(db, { assignmentId: 'as-1', toProfileId: 'coach-z' })
    expect(ctx.toIsMember).toBe(false)
    expect(ctx.toProfile).toBeNull()
    expect(chainsFor(db, 'profiles')).toEqual([])
  })

  it('no such assignment: nothing else is read', async () => {
    const db = scriptedDb({ shift_assignments: [{ data: null, error: null }] })
    expect(await readReplaceContext(db, { assignmentId: 'x', toProfileId: 'coach-b' }))
      .toEqual({ error: null, assignment: null, block: null, toIsMember: false, toProfile: null, liveOnBlockIds: [] })
  })

  it('any read error is returned, never read as "empty"', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: A_ROW, error: null }, { data: null, error: { message: 'boom' } }],
      profile_locations: [{ data: [{ profile_id: 'coach-b' }], error: null }],
      profiles: [{ data: { id: 'coach-b', active: true }, error: null }],
    })
    expect((await readReplaceContext(db, { assignmentId: 'as-1', toProfileId: 'coach-b' })).error).toEqual({ message: 'boom' })
  })
})

describe('replaceShiftAssignment', () => {
  const NOW = '2026-09-28T20:00:00.000Z'
  const run = (db) => replaceShiftAssignment(db, { assignment: A_ROW, toProfileId: 'coach-b', actorId: 'mgr-1', nowIso: NOW })

  it('clears B\'s tombstone, moves the row under all four guards, clears what described A, closes open swaps', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: null, error: null }, { data: [{ id: 'as-1' }], error: null }],
      shift_swap_requests: [{ data: [{ id: 'sw-1' }], error: null }],
    })
    expect(await run(db)).toEqual({ ok: true, closedSwapIds: ['sw-1'] })

    const [tomb, move] = chainsFor(db, 'shift_assignments')
    expect(argsOf(tomb, 'delete')).toEqual([])
    expect(allArgsOf(tomb, 'eq')).toEqual([['block_id', 'b1'], ['profile_id', 'coach-b'], ['status', 'cancelled']])

    expect(argsOf(move, 'update')[0]).toEqual({
      profile_id: 'coach-b', status: 'scheduled',
      start_time_override: null, end_time_override: null, partial_reason: null, arrived_at: null, arrival_source: null,
      notes: null, assigned_by: 'mgr-1', assigned_at: NOW,
    })
    expect(allArgsOf(move, 'eq')).toEqual([['id', 'as-1'], ['profile_id', 'coach-a']])
    expect(argsOf(move, 'neq')).toEqual(['status', 'cancelled'])
    expect(argsOf(move, 'is')).toEqual(['arrived_at', null])
    expect(argsOf(move, 'select')).toEqual(['id'])

    const [swaps] = chainsFor(db, 'shift_swap_requests')
    expect(argsOf(swaps, 'update')[0]).toEqual({ status: 'cancelled', reviewed_by: 'mgr-1', reviewed_at: NOW, review_note: 'Closed: a manager gave this shift to another coach.' })
    expect(argsOf(swaps, 'or')).toEqual(['requester_shift_id.eq.as-1,target_shift_id.eq.as-1'])
    expect(argsOf(swaps, 'in')).toEqual(['status', ['pending', 'awaiting_approval']])
  })

  it('zero rows moved = the shift changed underneath: no swap is touched', async () => {
    const db = scriptedDb({ shift_assignments: [{ data: null, error: null }, { data: [], error: null }] })
    expect(await run(db)).toEqual({ code: 'changed' })
    expect(chainsFor(db, 'shift_swap_requests')).toEqual([])
  })

  it('23505 = B is already on the block (the unique key is the race-proof half)', async () => {
    const db = scriptedDb({ shift_assignments: [{ data: null, error: null }, { data: null, error: { code: '23505', message: 'dup' } }] })
    expect(await run(db)).toEqual({ code: 'already_on_shift' })
  })

  it('a failed tombstone clear or move is an error; nothing after it runs', async () => {
    const db1 = scriptedDb({ shift_assignments: [{ data: null, error: { message: 'no' } }] })
    expect(await run(db1)).toEqual({ error: { message: 'no' } })
    const db2 = scriptedDb({ shift_assignments: [{ data: null, error: null }, { data: null, error: { message: 'down' } }] })
    expect(await run(db2)).toEqual({ error: { message: 'down' } })
    expect(chainsFor(db2, 'shift_swap_requests')).toEqual([])
  })

  it('a failed swap close is LOGGED and the replace stands (the approval RPC refuses a stale swap anyway)', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: null, error: null }, { data: [{ id: 'as-1' }], error: null }],
      shift_swap_requests: [{ data: null, error: { message: 'swap table down' } }],
    })
    expect(await run(db)).toEqual({ ok: true, closedSwapIds: [] })
    expect(logError).toHaveBeenCalledWith('shift-replace', expect.stringMatching(/open swaps/), expect.objectContaining({ assignmentId: 'as-1' }))
  })
})
