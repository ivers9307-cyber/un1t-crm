// src/lib/shift-replace-notify.test.js
// REPLACE.1a — replace notices held by quiet hours (or lost with a dead
// after()) go out from the */5 cron, once, inside 07:00-22:00 studio time.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptedDb, chainsFor, argsOf, allArgsOf } from './scripted-db.test-helpers'

vi.mock('./roster-change-notify', () => ({ notifyRosterChanges: vi.fn(async () => ({ notified: 1 })) }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { notifyRosterChanges } = await import('./roster-change-notify')
const { logError } = await import('./log')
const { runReplaceNotices } = await import('./shift-replace-notify')
const { REPLACE_UNDONE_REASON } = await import('./shift-replace')

const IN_BAND = Date.parse('2026-09-29T06:05:00Z')  // 07:05 Dublin
const QUIET = Date.parse('2026-09-29T04:00:00Z')    // 05:00 Dublin
const row = (id, coach, action, over = {}) => ({
  id, location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-29', actor_id: 'mgr-1', coach_id: coach, action,
  created_at: '2026-09-28T22:10:00Z', shift_blocks: { start_time: '09:00:00' }, ...over,
})
const LOC = { data: [{ id: 'loc-1', timezone: 'Europe/Dublin' }], error: null }

beforeEach(() => vi.clearAllMocks())

describe('runReplaceNotices', () => {
  it('reads only unstamped replace rows, up to 48 h old, for today or later', async () => {
    const db = scriptedDb({ roster_change_log: [{ data: [], error: null }] })
    await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    const [c] = chainsFor(db, 'roster_change_log')
    expect(argsOf(c, 'is')).toEqual(['notified_at', null])
    expect(argsOf(c, 'eq')).toEqual(['details->>via', 'replace'])
    expect(allArgsOf(c, 'gte')).toEqual([['created_at', '2026-09-27T06:05:00.000Z'], ['block_date', '2026-09-29']])
  })

  it('in band: ONE notifyRosterChanges per studio and actor, with the net change and the start time', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-b', 'assigned')], error: null }],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges).toHaveBeenCalledWith(db, {
      locationId: 'loc-1', actorId: 'mgr-1', todayStr: '2026-09-29',
      changes: [
        { coachId: 'coach-a', blockId: 'b1', blockDate: '2026-09-29', startTime: '09:00:00', action: 'unassigned' },
        { coachId: 'coach-b', blockId: 'b1', blockDate: '2026-09-29', startTime: '09:00:00', action: 'assigned' },
      ],
    })
    expect(stats).toMatchObject({ rows: 2, groups: 1, quiet: 0, silent: 0, fresh: 0, errors: 0 })
  })

  it('a coach whose newest row is under 2 minutes old is left to the route this tick (it is still changing)', async () => {
    // A -> B an hour ago, then B -> C 30 s ago: B's pile is in flux, so B is
    // not told "added" now and "removed" five minutes later. A is told.
    const young = '2026-09-29T06:04:30Z'
    const db = scriptedDb({
      roster_change_log: [{ data: [
        row('r1', 'coach-a', 'unassigned', { created_at: '2026-09-29T05:00:00Z' }),
        row('r2', 'coach-b', 'assigned', { created_at: '2026-09-29T05:00:00Z' }),
        row('r3', 'coach-b', 'unassigned', { created_at: young }),
        row('r4', 'coach-c', 'assigned', { created_at: young }),
      ], error: null }],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges.mock.calls[0][1].changes.map((c) => c.coachId)).toEqual(['coach-a'])
    expect(stats.fresh).toBe(2)
  })

  it('quiet hours: nothing sent, nothing stamped; the next in-band tick sends', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned')], error: null }],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: QUIET, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).not.toHaveBeenCalled()
    expect(chainsFor(db, 'roster_change_log')).toHaveLength(1) // the read only
    expect(stats.quiet).toBe(1)
  })

  it('net zero (replaced and put back) is stamped with no message, at any hour, and marked so the drawer never says "told"', async () => {
    const db = scriptedDb({
      roster_change_log: [
        { data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-a', 'assigned', { created_at: '2026-09-28T22:40:00Z' })], error: null },
        { data: [{ id: 'r1' }, { id: 'r2' }], error: null },
      ],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: QUIET, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).not.toHaveBeenCalled()
    const [, stamp] = chainsFor(db, 'roster_change_log')
    expect(argsOf(stamp, 'update')[0]).toEqual({
      notified_at: new Date(QUIET).toISOString(),
      details: { via: 'replace', reason: REPLACE_UNDONE_REASON },
    })
    expect(argsOf(stamp, 'in')).toEqual(['id', ['r1', 'r2']])
    expect(argsOf(stamp, 'is')).toEqual(['notified_at', null])
    expect(stats).toMatchObject({ silent: 1, errors: 0 })
  })

  it('a failed silent stamp is an error in the stats and logged; the next tick retries', async () => {
    const db = scriptedDb({
      roster_change_log: [
        { data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-a', 'assigned', { created_at: '2026-09-28T22:40:00Z' })], error: null },
        { data: null, error: { message: 'down' } },
      ],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: QUIET, todayStr: '2026-09-29' })
    expect(stats).toMatchObject({ silent: 0, errors: 1 })
    expect(logError).toHaveBeenCalledWith('shift-replace-notify', expect.stringMatching(/undone/), expect.anything())
  })

  it('an unreadable log is an error in the stats, logged, and nothing else runs', async () => {
    const db = scriptedDb({ roster_change_log: [{ data: null, error: { message: 'down' } }] })
    expect((await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })).errors).toBe(1)
    expect(logError).toHaveBeenCalled()
  })

  it('an unreadable timezone is Europe/Dublin, never a skipped studio', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned')], error: null }],
      locations: [{ data: null, error: { message: 'x' } }],
    })
    await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
  })

  it('one group throwing costs neither the others nor the arm', async () => {
    notifyRosterChanges.mockRejectedValueOnce(new Error('boom'))
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-b', 'assigned', { actor_id: 'mgr-2' })], error: null }],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(2)
    expect(stats).toMatchObject({ groups: 1, errors: 1 })
  })
})
