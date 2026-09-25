// src/lib/shift-replace-notify.test.js
// REPLACE.1a — replace notices held by quiet hours (or lost with a dead
// after()) go out from the */5 cron, once, inside 07:00-22:00 studio time.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptedDb, chainsFor, argsOf, allArgsOf } from './scripted-db.test-helpers'

// Every coach it is asked about was told, unless a test says otherwise.
const toldAll = async (_db, { changes }) => ({ byCoach: Object.fromEntries(changes.map((c) => [c.coachId, 'delivered'])) })
vi.mock('./roster-change-notify', () => ({ notifyRosterChanges: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { notifyRosterChanges } = await import('./roster-change-notify')
const { logError } = await import('./log')
const { runReplaceNotices } = await import('./shift-replace-notify')
const { REPLACE_UNDONE_REASON, REPLACE_STARTED_REASON } = await import('./shift-replace')

const IN_BAND = Date.parse('2026-09-29T06:05:00Z')  // 07:05 Dublin
const QUIET = Date.parse('2026-09-29T04:00:00Z')    // 05:00 Dublin
const row = (id, coach, action, over = {}) => ({
  id, location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-29', actor_id: 'mgr-1', coach_id: coach, action,
  created_at: '2026-09-28T22:10:00Z', shift_blocks: { start_time: '09:00:00' }, ...over,
})
const LOC = { data: [{ id: 'loc-1', timezone: 'Europe/Dublin' }], error: null }

beforeEach(() => {
  vi.clearAllMocks()
  notifyRosterChanges.mockImplementation(toldAll)
})
const STAMPED = (ids) => ({ data: ids.map((id) => ({ id })), error: null })

describe('runReplaceNotices', () => {
  it('reads only unstamped replace rows, up to 48 h old, for today or later', async () => {
    const db = scriptedDb({ roster_change_log: [{ data: [], error: null }] })
    await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    const [c] = chainsFor(db, 'roster_change_log')
    expect(argsOf(c, 'is')).toEqual(['notified_at', null])
    expect(argsOf(c, 'eq')).toEqual(['details->>via', 'replace'])
    expect(allArgsOf(c, 'gte')).toEqual([['created_at', '2026-09-27T06:05:00.000Z'], ['block_date', '2026-09-29']])
  })

  it('in band: ONE notifyRosterChanges per studio and actor, with the net change and the start time; the arm stamps its OWN rows after delivery', async () => {
    const db = scriptedDb({
      roster_change_log: [
        { data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-b', 'assigned')], error: null },
        STAMPED(['r1']), STAMPED(['r2']),
      ],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges).toHaveBeenCalledWith(db, {
      locationId: 'loc-1', actorId: 'mgr-1', todayStr: '2026-09-29', markNotified: false,
      changes: [
        { coachId: 'coach-a', blockId: 'b1', blockDate: '2026-09-29', startTime: '09:00:00', action: 'unassigned' },
        { coachId: 'coach-b', blockId: 'b1', blockDate: '2026-09-29', startTime: '09:00:00', action: 'assigned' },
      ],
    })
    expect(stats).toMatchObject({ rows: 2, groups: 1, told: 2, quiet: 0, silent: 0, fresh: 0, stamp_failed: 0, errors: 0 })
    const [, stampA, stampB] = chainsFor(db, 'roster_change_log')
    expect(argsOf(stampA, 'update')[0]).toEqual({ notified_at: new Date(IN_BAND).toISOString() })
    expect(argsOf(stampA, 'in')).toEqual(['id', ['r1']])
    expect(argsOf(stampA, 'is')).toEqual(['notified_at', null])
    expect(argsOf(stampB, 'in')).toEqual(['id', ['r2']])
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
      ], error: null }, STAMPED(['r1'])],
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
    expect(logError).toHaveBeenCalledWith('shift-replace-notify', expect.stringMatching(/owe no message/), expect.objectContaining({ reason: REPLACE_UNDONE_REASON }))
  })

  it('an unreadable log is an error in the stats, logged, and nothing else runs', async () => {
    const db = scriptedDb({ roster_change_log: [{ data: null, error: { message: 'down' } }] })
    expect((await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })).errors).toBe(1)
    expect(logError).toHaveBeenCalled()
  })

  it('an unreadable timezone is Europe/Dublin, never a skipped studio', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned')], error: null }, STAMPED(['r1'])],
      locations: [{ data: null, error: { message: 'x' } }],
    })
    await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
  })

  // REPLACE.1a review 1 — a delivered notice whose stamp fails would be sent
  // again next tick. That is the right failure (a duplicate, never a loss),
  // but it must be COUNTED so the arm's heartbeat goes stale instead of green.
  it('a delivered notice whose stamp fails is stamp_failed (not healthy); the other coach is still stamped', async () => {
    const db = scriptedDb({
      roster_change_log: [
        { data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-b', 'assigned')], error: null },
        { data: null, error: { message: 'down' } }, STAMPED(['r2']),
      ],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(stats).toMatchObject({ told: 2, stamp_failed: 1, errors: 0 })
    expect(logError).toHaveBeenCalledWith('shift-replace-notify', expect.stringMatching(/told again/), expect.objectContaining({ rowIds: ['r1'] }))
  })

  it('a coach told about the same rows by someone else meanwhile (0 rows stamped) is fine: nothing owed, not a fault', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned')], error: null }, STAMPED([])],
      locations: [LOC],
    })
    expect(await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })).toMatchObject({ told: 1, stamp_failed: 0 })
  })

  it('self and past outcomes are stamped too; opted-out / unreachable / failed are left for the next tick and counted', async () => {
    notifyRosterChanges.mockImplementation(async () => ({ byCoach: { 'coach-a': 'self', 'coach-b': 'opted_out', 'coach-c': 'undelivered', 'coach-d': 'failed' } }))
    const db = scriptedDb({
      roster_change_log: [
        { data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-b', 'assigned'), row('r3', 'coach-c', 'assigned'), row('r4', 'coach-d', 'assigned')], error: null },
        STAMPED(['r1']),
      ],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(chainsFor(db, 'roster_change_log')).toHaveLength(2) // the read + coach-a's stamp
    expect(stats).toMatchObject({ told: 0, undelivered: 2, send_failed: 1, stamp_failed: 0, errors: 0 })
  })

  // The undo trap: B was told "added" (the route's after(), in band) but the
  // stamp failed; the manager puts A back overnight. B's pile balances, yet B
  // must hear "removed", or B turns up to a shift they are no longer on.
  it('a pile whose "added" row may already have been told is not silent: B is told "removed" in the morning', async () => {
    const pile = [
      row('r2', 'coach-b', 'assigned', { created_at: '2026-09-28T20:00:00Z' }),   // 21:00 Dublin, in band
      row('r3', 'coach-b', 'unassigned', { created_at: '2026-09-28T22:30:00Z' }), // 23:30 Dublin, quiet
    ]
    const night = scriptedDb({ roster_change_log: [{ data: pile, error: null }], locations: [LOC] })
    expect(await runReplaceNotices(night, { nowMs: QUIET, todayStr: '2026-09-29' })).toMatchObject({ silent: 0, quiet: 1 })
    expect(chainsFor(night, 'roster_change_log')).toHaveLength(1) // nothing stamped overnight

    const morning = scriptedDb({ roster_change_log: [{ data: pile, error: null }, STAMPED(['r2', 'r3'])], locations: [LOC] })
    await runReplaceNotices(morning, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges.mock.calls.at(-1)[1].changes).toEqual([expect.objectContaining({ coachId: 'coach-b', action: 'unassigned' })])
  })

  it('the same pile made entirely overnight IS silent (nobody could have been told)', async () => {
    const pile = [
      row('r2', 'coach-b', 'assigned', { created_at: '2026-09-28T22:00:00Z' }),
      row('r3', 'coach-b', 'unassigned', { created_at: '2026-09-28T22:30:00Z' }),
    ]
    const db = scriptedDb({ roster_change_log: [{ data: pile, error: null }, STAMPED(['r2', 'r3'])], locations: [LOC] })
    expect(await runReplaceNotices(db, { nowMs: QUIET, todayStr: '2026-09-29' })).toMatchObject({ silent: 1 })
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })

  // Review 3 — a notice about a shift that has already started is no use:
  // the 07:00 arm must not tell B about a 06:00 shift. The pile is stamped
  // with no message, marked so the drawer never says "told". The manager was
  // warned to ring (the toast), and it happens at any hour.
  it('a pile whose shift has started (studio clock) is stamped silently with the started reason, and nobody is told', async () => {
    const early = { shift_blocks: { start_time: '06:00:00' } }
    const db = scriptedDb({
      roster_change_log: [
        { data: [row('r1', 'coach-a', 'unassigned', early), row('r2', 'coach-b', 'assigned', early)], error: null },
        STAMPED(['r1', 'r2']),
      ],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' }) // 07:05 Dublin
    expect(notifyRosterChanges).not.toHaveBeenCalled()
    const [, stamp] = chainsFor(db, 'roster_change_log')
    expect(argsOf(stamp, 'update')[0]).toEqual({ notified_at: new Date(IN_BAND).toISOString(), details: { via: 'replace', reason: REPLACE_STARTED_REASON } })
    expect(argsOf(stamp, 'in')).toEqual(['id', ['r1', 'r2']])
    expect(argsOf(stamp, 'is')).toEqual(['notified_at', null])
    expect(stats).toMatchObject({ started: 2, told: 0, errors: 0 })
  })

  it('in quiet hours too: a 04:30 shift at 05:00 is stamped, not held for 07:00', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned', { shift_blocks: { start_time: '04:30:00' } })], error: null }, STAMPED(['r1'])],
      locations: [LOC],
    })
    expect(await runReplaceNotices(db, { nowMs: QUIET, todayStr: '2026-09-29' })).toMatchObject({ started: 1, quiet: 0 })
  })

  it('a shift not yet started is told as usual, and one that has started beside it is not', async () => {
    const db = scriptedDb({
      roster_change_log: [
        { data: [row('r1', 'coach-a', 'unassigned', { shift_blocks: { start_time: '06:00:00' } }), row('r2', 'coach-b', 'assigned', { block_id: 'b2' })], error: null },
        STAMPED(['r1']), STAMPED(['r2']),
      ],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges.mock.calls[0][1].changes.map((c) => c.coachId)).toEqual(['coach-b'])
    expect(stats).toMatchObject({ started: 1, told: 1 })
  })

  it('a failed started-stamp is an error; the next tick retries', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned', { shift_blocks: { start_time: '06:00:00' } })], error: null }, { data: null, error: { message: 'down' } }],
      locations: [LOC],
    })
    expect(await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })).toMatchObject({ started: 0, errors: 1 })
  })
})
