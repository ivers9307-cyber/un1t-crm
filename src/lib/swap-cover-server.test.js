// src/lib/swap-cover-server.test.js
// COVERLOOP.1 — the DB half: which rows are read, what happens when a read
// fails, and (Task 5) that the sweep cancels with a status guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('./push', () => ({
  resolveRoleRecipientIds: vi.fn(),
}))
vi.mock('./push-dedup', () => ({
  notifyUsersOnce: vi.fn(),
  notifyUsersAtRolesOnce: vi.fn(),
}))

const { logWarn, logError } = await import('./log')
const { resolveRoleRecipientIds } = await import('./push')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('./push-dedup')
const { MANAGER_ROLES } = await import('./schemas')
const { notifyOpenPool, runSwapCoverSweep } = await import('./swap-cover-server')
const { SWAP_EXPIRY_NOTES } = await import('./swap-cover')

// A thenable builder per from() call. Records the select, the filters and any
// update patch; resolves to results[table], which may be a function of the
// recorded query (so one table can answer a read and a write differently).
function mockDb(results = {}) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, select: null, update: null, filters: [], single: false }
      queries.push(q)
      const b = {
        select: (cols) => { q.select = cols; return b },
        update: (patch) => { q.update = patch; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); return b },
        lte: (c, v) => { q.filters.push(['lte', c, v]); return b },
        gte: (c, v) => { q.filters.push(['gte', c, v]); return b },
        is: (c, v) => { q.filters.push(['is', c, v]); return b },
        order: () => b,
        limit: () => b,
        maybeSingle: () => { q.single = true; return b },
        then: (res, rej) => {
          const r = typeof results[table] === 'function' ? results[table](q) : results[table]
          return Promise.resolve(r ?? { data: q.single ? null : [], error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}

const LOC = 'loc-1'
const SIBLING = 'loc-2'
const ORG = 'org-1'
const BLOCK = { id: 'blk-1', block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00' }
const REQUESTER = { id: 'req', full_name: 'Coach R' }
const ARGS = { swapId: 'swap-1', locationId: LOC, block: BLOCK, requester: REQUESTER }

const link = (profile_id, over = {}) => ({
  profile_id, location_id: LOC, role: 'staff', profiles: { id: profile_id, role: 'staff', active: true }, ...over,
})
const MEMBERS = [link('req'), link('a'), link('b'), link('mgr', { role: 'manager' })]
// locations answers two reads: this studio's organisation, then that
// organisation's studios.
const locationsTable = (q) => (q.single
  ? { data: { id: LOC, name: 'Studio North', organization_id: ORG }, error: null }
  : { data: [{ id: LOC }, { id: SIBLING }], error: null })
const healthy = (over = {}) => ({
  profile_locations: { data: MEMBERS, error: null },
  locations: locationsTable,
  ...over,
})
// A live shift at THIS studio that day on a published roster.
const shiftHere = (profile_id, start, end, over = {}) => ({
  id: `as-${profile_id}`, profile_id, block_id: `blk-${profile_id}`, status: 'scheduled',
  start_time_override: null, end_time_override: null,
  shift_blocks: { id: `blk-${profile_id}`, location_id: LOC, block_date: '2026-09-24', start_time: start, end_time: end, rosters: { status: 'published' } },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  resolveRoleRecipientIds.mockResolvedValue(['mgr'])
  notifyUsersOnce.mockResolvedValue({ sent: 1, emailed: 0, deduped: 0 })
  notifyUsersAtRolesOnce.mockResolvedValue({ sent: 1, emailed: 0, deduped: 0 })
})

describe('notifyOpenPool', () => {
  it('tells every free member of the studio, off-day coaches included, and says when the shift is', async () => {
    const db = mockDb(healthy())
    const out = await notifyOpenPool(db, ARGS)

    // Members of THIS studio only.
    const members = db.queries.find((q) => q.table === 'profile_locations')
    expect(members.filters).toEqual([['eq', 'location_id', LOC]])
    // The SAME resolver and role set notifyUsersAtRolesOnce uses for swap_open.
    expect(resolveRoleRecipientIds).toHaveBeenCalledWith(db, LOC, MANAGER_ROLES)

    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [dbArg, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(key).toBe('swap_open_pool:swap-1')
    expect(ids).toEqual(['a', 'b'])
    expect(payload).toEqual({
      title: 'A shift needs cover',
      body: 'Coach R needs cover at Studio North: Thu 24 Sep, 06:00 to 07:00. Tap to take it.',
      category: 'swap',
      emailSubject: 'A shift needs cover at Studio North: Thu 24 Sep, 06:00 to 07:00',
      data: { type: 'swap_open_pool', swap_id: 'swap-1', block_date: '2026-09-24' },
    })
    expect(out).toEqual({ notified: 2, degraded: false })
  })

  it('reads leave by person, and that day\'s shifts ONLY at studios in the same organisation', async () => {
    const db = mockDb(healthy())
    await notifyOpenPool(db, ARGS)

    const [orgOf, orgStudios] = db.queries.filter((q) => q.table === 'locations')
    expect(orgOf.filters).toEqual([['eq', 'id', LOC]])
    // The studio's name rides on the read that was already being made.
    expect(orgOf.select).toBe('id, name, organization_id')
    expect(orgStudios.filters).toEqual([['eq', 'organization_id', ORG]])

    const leave = db.queries.find((q) => q.table === 'time_off_requests')
    expect(leave.select).toContain('total_days')
    expect(leave.filters).toEqual([
      ['in', 'profile_id', ['a', 'b']], ['eq', 'status', 'approved'],
      ['lte', 'start_date', '2026-09-24'], ['gte', 'end_date', '2026-09-24'],
    ])
    // TENANCY: a coach cannot be at two studios at once, but another
    // organisation's roster is never read.
    const assigns = db.queries.find((q) => q.table === 'shift_assignments')
    expect(assigns.filters).toEqual([
      ['in', 'profile_id', ['a', 'b']],
      ['eq', 'shift_blocks.block_date', '2026-09-24'],
      ['in', 'shift_blocks.location_id', [LOC, SIBLING]],
    ])
  })

  it('a studio with no organisation reads its own shifts only', async () => {
    const db = mockDb(healthy({ locations: (q) => (q.single ? { data: { id: LOC, organization_id: null }, error: null } : { data: [], error: null }) }))
    await notifyOpenPool(db, ARGS)
    expect(db.queries.filter((q) => q.table === 'locations')).toHaveLength(1)
    const assigns = db.queries.find((q) => q.table === 'shift_assignments')
    expect(assigns.filters).toContainEqual(['in', 'shift_blocks.location_id', [LOC]])
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['a', 'b'])
  })

  it('drops a coach on approved leave and a coach on an overlapping shift at a sibling studio', async () => {
    const db = mockDb(healthy({
      time_off_requests: { data: [{ id: 't1', profile_id: 'a', type: 'holiday', status: 'approved', start_date: '2026-09-24', end_date: '2026-09-24', total_days: 1 }], error: null },
      shift_assignments: { data: [{
        id: 'a9', profile_id: 'b', block_id: 'blk-9', status: 'scheduled', start_time_override: null, end_time_override: null,
        shift_blocks: { id: 'blk-9', location_id: SIBLING, block_date: '2026-09-24', start_time: '06:30:00', end_time: '08:00:00', rosters: { status: 'published' } },
      }], error: null },
    }))
    const out = await notifyOpenPool(db, ARGS)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(out).toEqual({ notified: 0, degraded: false })
  })

  // FAILURE MODES. A failed read may only SHRINK the audience to (at most) the
  // pre-COVERLOOP one: coaches with a live shift here that day on a published
  // roster. It never widens it, never reads wider, and is always logged.
  describe('when a read fails', () => {
    it('members unreadable: nobody is told, and it is logged', async () => {
      const db = mockDb(healthy({ profile_locations: { data: null, error: { message: 'boom' } } }))
      expect(await notifyOpenPool(db, ARGS)).toEqual({ notified: 0, degraded: true })
      expect(notifyUsersOnce).not.toHaveBeenCalled()
      expect(db.queries.some((q) => q.table === 'shift_assignments')).toBe(false)
      // Nothing retries this broadcast: nobody hearing is an ERROR, not a warning.
      expect(logError).toHaveBeenCalledWith('swap-cover', expect.stringContaining('members'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
    })

    it('leave unreadable: only coaches already working here that day are told', async () => {
      const db = mockDb(healthy({
        time_off_requests: { data: null, error: { message: 'boom' } },
        shift_assignments: { data: [shiftHere('a', '09:00:00', '10:00:00')], error: null },
      }))
      const out = await notifyOpenPool(db, ARGS)
      expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['a'])
      expect(out).toEqual({ notified: 1, degraded: true })
      expect(logWarn).toHaveBeenCalledWith('swap-cover', expect.stringContaining('leave'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
    })

    it('shifts unreadable: nobody is told (the old rule could not name anyone either)', async () => {
      const db = mockDb(healthy({ shift_assignments: { data: null, error: { message: 'boom' } } }))
      expect(await notifyOpenPool(db, ARGS)).toEqual({ notified: 0, degraded: true })
      expect(notifyUsersOnce).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalledWith('swap-cover', expect.stringContaining('shifts'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
    })

    it.each([
      ['the studio\'s organisation', (q) => (q.single ? { data: null, error: { message: 'boom' } } : { data: [], error: null })],
      ['the organisation\'s studios', (q) => (q.single ? { data: { id: LOC, organization_id: ORG }, error: null } : { data: null, error: { message: 'boom' } })],
    ])('%s unreadable: shifts are read for THIS studio only, and only coaches working here are told', async (_label, locations) => {
      const db = mockDb(healthy({
        locations,
        shift_assignments: { data: [shiftHere('b', '09:00:00', '10:00:00')], error: null },
      }))
      const out = await notifyOpenPool(db, ARGS)
      const assigns = db.queries.find((q) => q.table === 'shift_assignments')
      expect(assigns.filters).toContainEqual(['in', 'shift_blocks.location_id', [LOC]])
      expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['b'])
      expect(out).toEqual({ notified: 1, degraded: true })
      expect(logWarn).toHaveBeenCalledWith('swap-cover', expect.stringContaining('organisation'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
    })

    it('the manager resolver coming back empty does not turn managers into pool recipients', async () => {
      resolveRoleRecipientIds.mockResolvedValue([])
      await notifyOpenPool(mockDb(healthy()), ARGS)
      expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['a', 'b'])
    })
  })

  it('reads nothing more and sends nothing when the studio has no other coach', async () => {
    const db = mockDb(healthy({ profile_locations: { data: [link('req'), link('mgr', { role: 'manager' })], error: null } }))
    expect(await notifyOpenPool(db, ARGS)).toEqual({ notified: 0, degraded: false })
    expect(db.queries.map((q) => q.table)).toEqual(['profile_locations'])
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('says "A coach" when the requester has no full_name (it is nullable on profiles)', async () => {
    await notifyOpenPool(mockDb(healthy()), { ...ARGS, requester: { id: 'req', full_name: null } })
    const payload = notifyUsersOnce.mock.calls[0][3]
    expect(payload.body).toBe('A coach needs cover at Studio North: Thu 24 Sep, 06:00 to 07:00. Tap to take it.')
    expect(payload.body).not.toContain('null')
  })

  it('does nothing without a block date', async () => {
    const db = mockDb(healthy())
    expect(await notifyOpenPool(db, { ...ARGS, block: { id: 'blk-1' } })).toEqual({ notified: 0, degraded: false })
    expect(db.queries).toHaveLength(0)
    expect(resolveRoleRecipientIds).not.toHaveBeenCalled()
  })
})

const H = 3600 * 1000
// 09:00 Dublin, winter (= 09:00Z). Every boundary these tests stand on
// (T-48h 09:00, T-40h 17:00, the start, +1h) is inside the 07:00-22:00 band;
// the quiet-hours tests below pick their own times.
const START = Date.UTC(2099, 0, 1, 9, 0)
const sweepSwap = (over = {}) => ({
  id: 's1', status: 'pending', location_id: LOC, requester_id: 'req', target_id: null,
  requester_shift_id: 'a1', created_at: new Date(START - 200 * H).toISOString(),
  requester: { full_name: 'Coach R' },
  requester_shift: { id: 'a1', shift_blocks: { id: 'blk-1', block_date: '2099-01-01', start_time: '09:00:00', end_time: '10:00:00' } },
  ...over,
})
// One table, three kinds of query: the open-swap list, the guarded cancel, and
// the recently-system-closed list the deferred-notice pass reads.
const isClosedRead = (q) => !q.update && q.filters.some((f) => f[0] === 'eq' && f[1] === 'status' && f[2] === 'cancelled')
const swapsTable = (list, updateResult = { data: [{ id: 's1' }], error: null }, closed = []) =>
  (q) => {
    if (q.update) return updateResult
    return { data: isClosedRead(q) ? closed : list, error: null }
  }
const DUBLIN = { data: [{ id: LOC, timezone: 'Europe/Dublin' }], error: null }
const ZERO = { open: 0, nudged: 0, expired: 0, skipped: 0, quiet: 0, announced: 0, errors: 0 }

// A STATEFUL shift_swap_requests + a real at-most-once ledger, for the tests
// that follow one swap across several ticks. `clock.now` is the tick's time:
// the UPDATE stamps updated_at with it, as the mig 010 trigger would.
function world(rows, clock) {
  const ledger = new Set()
  notifyUsersOnce.mockImplementation(async (_db, key, ids) => {
    const fresh = ids.filter((id) => !ledger.has(`${key}|${id}`))
    fresh.forEach((id) => ledger.add(`${key}|${id}`))
    return { sent: fresh.length, emailed: 0, deduped: ids.length - fresh.length }
  })
  const table = (q) => {
    const eq = (col) => q.filters.find((f) => f[0] === 'eq' && f[1] === col)?.[2]
    if (q.update) {
      const hit = rows.filter((r) => r.id === eq('id') && r.status === eq('status'))
      hit.forEach((r) => Object.assign(r, q.update, { updated_at: new Date(clock.now).toISOString() }))
      return { data: hit.map((r) => ({ id: r.id })), error: null }
    }
    if (isClosedRead(q)) {
      const notes = q.filters.find((f) => f[0] === 'in' && f[1] === 'review_note')[2]
      const since = q.filters.find((f) => f[0] === 'gte' && f[1] === 'updated_at')[2]
      return { data: rows.filter((r) => r.status === 'cancelled' && r.reviewed_by == null && notes.includes(r.review_note) && r.updated_at >= since).map((r) => ({ ...r })), error: null }
    }
    const open = q.filters.find((f) => f[0] === 'in' && f[1] === 'status')[2]
    return { data: rows.filter((r) => open.includes(r.status)).map((r) => ({ ...r })), error: null }
  }
  return { db: mockDb({ shift_swap_requests: table, locations: DUBLIN }), ledger }
}
const tick = (w, clock, nowMs) => { clock.now = nowMs; return runSwapCoverSweep(w.db, { nowMs }) }

describe('runSwapCoverSweep', () => {
  it('reads OPEN swaps, and swaps the sweep itself closed in the last 24h, and nothing else when there are none', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([]) })
    const stats = await runSwapCoverSweep(db, { nowMs: START })
    expect(db.queries).toHaveLength(2)
    expect(db.queries[0].filters).toEqual([['in', 'status', ['pending', 'awaiting_approval']]])
    // Bounded, and matched on the EXACT system notes: a coach's own cancel or
    // a manager's decision can never be announced as an expiry.
    expect(db.queries[1].filters).toEqual([
      ['eq', 'status', 'cancelled'],
      ['is', 'reviewed_by', null],
      ['in', 'review_note', [SWAP_EXPIRY_NOTES.started, SWAP_EXPIRY_NOTES.started_claimed]],
      ['gte', 'updated_at', new Date(START - 24 * H).toISOString()],
    ])
    expect(stats).toEqual(ZERO)
  })

  it('reads the timezone of exactly the studios that have an open swap', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap(), sweepSwap({ id: 's2' })]), locations: DUBLIN })
    await runSwapCoverSweep(db, { nowMs: START - 100 * H })
    const loc = db.queries.find((q) => q.table === 'locations')
    expect(loc.select).toBe('id, timezone')
    expect(loc.filters).toEqual([['in', 'id', [LOC]]])
  })

  it('re-pushes the studio\'s approvers at T-48h, keyed per swap, status and stage', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]), locations: DUBLIN })
    const stats = await runSwapCoverSweep(db, { nowMs: START - 48 * H })

    // The same recipients swap_open reached: the SAME resolver, the same role
    // set, at the swap's own studio.
    expect(resolveRoleRecipientIds).toHaveBeenCalledWith(db, LOC, MANAGER_ROLES)
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [dbArg, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(key).toBe('swap_cover_nudge:s1:pending:t48')
    expect(ids).toEqual(['mgr'])
    expect(payload.body).toContain('Still uncovered: Thu 1 Jan, 09:00 to 10:00')
    expect(payload.data).toEqual({ type: 'swap_open', swap_id: 's1' })
    expect(stats).toMatchObject({ open: 1, nudged: 1, expired: 0 })
    // a nudge writes nothing
    expect(db.queries.some((q) => q.update)).toBe(false)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('the sweep row carries what the pure decision needs: the claim time and the effective start', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([]) })
    await runSwapCoverSweep(db, { nowMs: START })
    for (const q of db.queries) {
      expect(q.select).toContain('updated_at')
      expect(q.select).toContain('start_time_override')
      expect(q.select).toContain('reviewed_by, review_note')
    }
  })

  // A manager who posts their OWN swap is not chased to review it.
  it('never nudges the requester about their own swap', async () => {
    resolveRoleRecipientIds.mockResolvedValue(['mgr', 'req', 'mgr2'])
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]), locations: DUBLIN })
    await runSwapCoverSweep(db, { nowMs: START - 48 * H })
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['mgr', 'mgr2'])
  })

  it('a studio whose only approver is the requester: nobody to nudge, nothing sent, not an error', async () => {
    resolveRoleRecipientIds.mockResolvedValue(['req'])
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]), locations: DUBLIN })
    const stats = await runSwapCoverSweep(db, { nowMs: START - 48 * H })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ nudged: 0, skipped: 1, errors: 0 })
  })

  it('a repeat tick is swallowed by the ledger and is not counted as a nudge', async () => {
    notifyUsersOnce.mockResolvedValue({ sent: 0, emailed: 0, deduped: 3 })
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]), locations: DUBLIN })
    expect(await runSwapCoverSweep(db, { nowMs: START - 40 * H })).toMatchObject({ nudged: 0, skipped: 1 })
  })

  it('cancels a started swap with a STATUS-GUARDED update, then tells the requester once', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]), locations: DUBLIN })
    const stats = await runSwapCoverSweep(db, { nowMs: START })

    const write = db.queries.find((q) => q.update)
    expect(write.update).toEqual({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.started })
    expect(Object.keys(write.update)).not.toContain('reviewed_by')
    // .eq('status', <what we read>): an approve RPC that won the race leaves 0 rows.
    expect(write.filters).toEqual([['eq', 'id', 's1'], ['eq', 'status', 'pending']])
    expect(write.select).toBe('id')

    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(key).toBe('swap_expired:s1')
    expect(ids).toEqual(['req'])
    expect(payload.data).toEqual({ type: 'swap_decision', swap_id: 's1', status: 'cancelled', block_date: '2099-01-01' })
    expect(stats).toMatchObject({ expired: 1, errors: 0 })
  })

  it('a claimed swap that expires tells the taker too', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap({ status: 'awaiting_approval', target_id: 'tkr' })]), locations: DUBLIN })
    await runSwapCoverSweep(db, { nowMs: START + H })
    expect(db.queries.find((q) => q.update).filters).toEqual([['eq', 'id', 's1'], ['eq', 'status', 'awaiting_approval']])
    // "It had been claimed" has to survive the cancel, for a deferred notice.
    expect(db.queries.find((q) => q.update).update.review_note).toBe(SWAP_EXPIRY_NOTES.started_claimed)
    expect(notifyUsersOnce.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['swap_expired:s1', ['req']],
      ['swap_expired_taker:s1', ['tkr']],
    ])
  })

  it('sends NOTHING when the cancel matched no row (a manager decided it first)', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()], { data: [], error: null }), locations: DUBLIN })
    const stats = await runSwapCoverSweep(db, { nowMs: START })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ expired: 0, skipped: 1, errors: 0 })
  })

  it('a failed cancel is an error, sends nothing, and the next swap is still processed', async () => {
    const second = sweepSwap({ id: 's2', requester_id: 'req2' })
    const db = mockDb({
      locations: DUBLIN,
      shift_swap_requests: (q) => {
        if (!q.update) return { data: [sweepSwap(), second], error: null }
        const id = q.filters.find((f) => f[1] === 'id')[2]
        return id === 's1' ? { data: null, error: { message: 'boom' } } : { data: [{ id: 's2' }], error: null }
      },
    })
    const stats = await runSwapCoverSweep(db, { nowMs: START })
    expect(stats).toMatchObject({ open: 2, expired: 1, errors: 1 })
    expect(notifyUsersOnce.mock.calls.map((c) => c[1])).toEqual(['swap_expired:s2'])
    expect(logError).toHaveBeenCalledWith('swap-cover', expect.any(String), expect.objectContaining({ swapId: 's1', err: 'boom' }))
  })

  it('a throwing send is one error and the next swap is still processed', async () => {
    notifyUsersOnce.mockRejectedValueOnce(new Error('push down'))
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap(), sweepSwap({ id: 's2' })]), locations: DUBLIN })
    const stats = await runSwapCoverSweep(db, { nowMs: START - 48 * H })
    expect(stats).toMatchObject({ open: 2, nudged: 1, errors: 1 })
  })

  it('closes a swap whose shift was deleted, quietly', async () => {
    const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap({ requester_shift_id: null, requester_shift: null })]), locations: DUBLIN })
    const stats = await runSwapCoverSweep(db, { nowMs: START - 500 * H })
    expect(db.queries.find((q) => q.update).update).toEqual({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.shift_removed })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ expired: 1 })
  })

  it('an unreadable swap list is one logged error and no work', async () => {
    const db = mockDb({ shift_swap_requests: (q) => (isClosedRead(q) ? { data: [], error: null } : { data: null, error: { message: 'down' } }) })
    expect(await runSwapCoverSweep(db, { nowMs: START })).toEqual({ ...ZERO, errors: 1 })
    expect(logError).toHaveBeenCalledWith('swap-cover', expect.any(String), expect.objectContaining({ err: 'down' }))
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  // QUIET HOURS — the decision is the pure function's (swap-cover.test.js has
  // the table). These pin that the sweep OBEYS it: no push AND no write.
  describe('quiet hours', () => {
    const early = (over = {}) => sweepSwap({
      requester_shift: { id: 'a1', shift_blocks: { id: 'blk-1', block_date: '2099-01-01', start_time: '06:00:00', end_time: '07:00:00' } },
      ...over,
    })

    // STATE does not wait for quiet hours; only the NOTICE does.
    it('a 06:00 shift that has started IS cancelled at 06:15, and nobody is pushed or claimed in the ledger', async () => {
      const db = mockDb({ shift_swap_requests: swapsTable([early()]), locations: DUBLIN })
      const stats = await runSwapCoverSweep(db, { nowMs: Date.UTC(2099, 0, 1, 6, 15) })
      const write = db.queries.find((q) => q.update)
      expect(write.update).toEqual({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.started })
      expect(write.filters).toEqual([['eq', 'id', 's1'], ['eq', 'status', 'pending']])
      // notifyUsersOnce CLAIMS its key before it sends, so "not called" is what
      // leaves the key free for the deferred notice.
      expect(notifyUsersOnce).not.toHaveBeenCalled()
      expect(stats).toEqual({ ...ZERO, open: 1, expired: 1 })
    })

    it('... at 07:00 the close and the notice go together', async () => {
      const db = mockDb({ shift_swap_requests: swapsTable([early()]), locations: DUBLIN })
      const stats = await runSwapCoverSweep(db, { nowMs: Date.UTC(2099, 0, 1, 7, 0) })
      expect(notifyUsersOnce.mock.calls.map((c) => c[1])).toEqual(['swap_expired:s1'])
      expect(stats).toMatchObject({ expired: 1, quiet: 0 })
    })

    it('a removed shift closes at night too, silently', async () => {
      const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap({ requester_shift_id: null, requester_shift: null })]), locations: DUBLIN })
      const stats = await runSwapCoverSweep(db, { nowMs: Date.UTC(2099, 0, 1, 3, 0) })
      expect(db.queries.find((q) => q.update).update).toEqual({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.shift_removed })
      expect(notifyUsersOnce).not.toHaveBeenCalled()
      expect(stats).toMatchObject({ expired: 1 })
    })

    describe('the deferred notice', () => {
      const late = (over = {}) => sweepSwap({
        requester_shift: { id: 'a1', start_time_override: null, shift_blocks: { id: 'blk-1', block_date: '2099-01-01', start_time: '22:30:00', end_time: '23:30:00' } },
        ...over,
      })
      const at = (d, h, m) => Date.UTC(2099, 0, d, h, m)

      it('22:30 shift: closed at 22:31 with no push; told on the first tick at or after 07:00; exactly once', async () => {
        const clock = { now: 0 }
        const rows = [late()]
        const w = world(rows, clock)

        expect(await tick(w, clock, at(1, 22, 31))).toMatchObject({ expired: 1, announced: 0 })
        expect(rows[0]).toMatchObject({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.started })
        expect(notifyUsersOnce).not.toHaveBeenCalled()

        // Through the night: closed, found by the second read, still not told.
        expect(await tick(w, clock, at(2, 3, 0))).toMatchObject({ open: 0, expired: 0, announced: 0 })
        expect(await tick(w, clock, at(2, 6, 45))).toMatchObject({ announced: 0 })
        expect(notifyUsersOnce).not.toHaveBeenCalled()

        expect(await tick(w, clock, at(2, 7, 0))).toMatchObject({ announced: 1 })
        expect(notifyUsersOnce.mock.calls.map((c) => [c[1], c[2]])).toEqual([['swap_expired:s1', ['req']]])
        expect(notifyUsersOnce.mock.calls[0][3].body).toContain('Thu 1 Jan, 22:30 to 23:30')

        // Every later tick offers the same key; the ledger refuses it.
        expect(await tick(w, clock, at(2, 7, 15))).toMatchObject({ announced: 0 })
        expect(await tick(w, clock, at(2, 12, 0))).toMatchObject({ announced: 0 })
        expect([...w.ledger]).toEqual(['swap_expired:s1|req'])
      })

      it('a CLAIMED swap closed at night: the requester AND the taker are told in the morning', async () => {
        const clock = { now: 0 }
        const rows = [late({ status: 'awaiting_approval', target_id: 'tkr' })]
        const w = world(rows, clock)
        await tick(w, clock, at(1, 22, 45))
        expect(rows[0]).toMatchObject({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.started_claimed, target_id: 'tkr' })
        await tick(w, clock, at(2, 7, 0))
        expect([...w.ledger].sort()).toEqual(['swap_expired:s1|req', 'swap_expired_taker:s1|tkr'])
      })

      it('a crash between the UPDATE and the send: the next in-band tick sends it', async () => {
        const clock = { now: 0 }
        // What a crash leaves behind: cancelled with the system note, in band,
        // and nothing in the ledger.
        const rows = [sweepSwap({ status: 'cancelled', reviewed_by: null, review_note: SWAP_EXPIRY_NOTES.started, updated_at: new Date(START).toISOString() })]
        const w = world(rows, clock)
        expect(await tick(w, clock, START + 15 * 60 * 1000)).toMatchObject({ open: 0, announced: 1 })
        expect([...w.ledger]).toEqual(['swap_expired:s1|req'])
      })

      it('a send that FAILED outright (the ledger released it) is retried by the next tick', async () => {
        const closed = [sweepSwap({ status: 'cancelled', reviewed_by: null, review_note: SWAP_EXPIRY_NOTES.started, updated_at: new Date(START).toISOString() })]
        notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, failed: 1, deduped: 0 })
        const db = mockDb({ shift_swap_requests: swapsTable([], undefined, closed), locations: DUBLIN })
        expect(await runSwapCoverSweep(db, { nowMs: START + H })).toMatchObject({ announced: 0 })
        expect(await runSwapCoverSweep(db, { nowMs: START + 2 * H })).toMatchObject({ announced: 1 })
      })

      it('nothing older than 24h is re-announced, even if a row were to arrive', async () => {
        const closed = [sweepSwap({ status: 'cancelled', reviewed_by: null, review_note: SWAP_EXPIRY_NOTES.started, updated_at: new Date(START - 25 * H).toISOString() })]
        const db = mockDb({ shift_swap_requests: swapsTable([], undefined, closed), locations: DUBLIN })
        expect(await runSwapCoverSweep(db, { nowMs: START })).toMatchObject({ announced: 0 })
        expect(notifyUsersOnce).not.toHaveBeenCalled()
      })

      it('a coach\'s own cancel or a manager\'s decision is never announced, even if a row were to arrive', async () => {
        const closed = [
          sweepSwap({ status: 'cancelled', reviewed_by: null, review_note: null, updated_at: new Date(START).toISOString() }),
          sweepSwap({ id: 's2', status: 'cancelled', reviewed_by: 'mgr', review_note: SWAP_EXPIRY_NOTES.started, updated_at: new Date(START).toISOString() }),
          sweepSwap({ id: 's3', status: 'cancelled', reviewed_by: null, review_note: SWAP_EXPIRY_NOTES.shift_removed, updated_at: new Date(START).toISOString() }),
        ]
        const db = mockDb({ shift_swap_requests: swapsTable([], undefined, closed), locations: DUBLIN })
        await runSwapCoverSweep(db, { nowMs: START + H })
        expect(notifyUsersOnce).not.toHaveBeenCalled()
      })

      it('an unreadable closed list is one logged error and the OPEN swaps are still swept', async () => {
        const db = mockDb({
          locations: DUBLIN,
          shift_swap_requests: (q) => {
            if (q.update) return { data: [{ id: 's1' }], error: null }
            return isClosedRead(q) ? { data: null, error: { message: 'closed down' } } : { data: [sweepSwap()], error: null }
          },
        })
        const stats = await runSwapCoverSweep(db, { nowMs: START })
        expect(stats).toMatchObject({ open: 1, expired: 1, errors: 1 })
        expect(logError).toHaveBeenCalledWith('swap-cover', expect.any(String), expect.objectContaining({ err: 'closed down' }))
      })
    })

    it('a manager nudge that comes due at night is not sent at night', async () => {
      const db = mockDb({ shift_swap_requests: swapsTable([sweepSwap()]), locations: DUBLIN })
      // T-7h = 02:00: deep inside the t12 stage, and the middle of the night.
      const stats = await runSwapCoverSweep(db, { nowMs: START - 7 * H })
      expect(notifyUsersOnce).not.toHaveBeenCalled()
      expect(stats).toEqual({ ...ZERO, open: 1, quiet: 1 })
    })

    it('uses the STUDIO\'s timezone for both the shift start and the band', async () => {
      // 09:00Z is 04:00 in New York: the 09:00 EST shift has not started, its
      // t12 nudge is due, and it is the middle of the studio's night. Under
      // Dublin time this same instant would have EXPIRED the swap.
      const db = mockDb({
        shift_swap_requests: swapsTable([sweepSwap()]),
        locations: { data: [{ id: LOC, timezone: 'America/New_York' }], error: null },
      })
      const stats = await runSwapCoverSweep(db, { nowMs: START })
      expect(db.queries.some((q) => q.update)).toBe(false)
      expect(notifyUsersOnce).not.toHaveBeenCalled()
      expect(stats).toEqual({ ...ZERO, open: 1, quiet: 1 })
      // 12:00Z is 07:00 EST: the nudge goes.
      await runSwapCoverSweep(db, { nowMs: START + 3 * H })
      expect(notifyUsersOnce.mock.calls.map((c) => c[1])).toEqual(['swap_cover_nudge:s1:pending:t12'])
    })

    it.each([
      ['an invalid', 'Mars/Olympus'],
      ['an empty', ''],
      ['a null', null],
    ])('%s timezone falls back to Europe/Dublin with ONE warning per studio, never a throw', async (_label, timezone) => {
      const db = mockDb({
        shift_swap_requests: swapsTable([sweepSwap(), sweepSwap({ id: 's2' })]),
        locations: { data: [{ id: LOC, timezone }], error: null },
      })
      const stats = await runSwapCoverSweep(db, { nowMs: START - 48 * H })
      expect(stats).toMatchObject({ open: 2, nudged: 2, errors: 0 })
      const tzWarnings = logWarn.mock.calls.filter((c) => String(c[1]).includes('timezone'))
      expect(tzWarnings).toHaveLength(1)
      expect(tzWarnings[0][2]).toMatchObject({ locationId: LOC })
    })

    it('an unreadable locations table is Europe/Dublin for everyone, logged, and the sweep still runs', async () => {
      const db = mockDb({
        shift_swap_requests: swapsTable([sweepSwap()]),
        locations: { data: null, error: { message: 'down' } },
      })
      const stats = await runSwapCoverSweep(db, { nowMs: START - 48 * H })
      expect(stats).toMatchObject({ nudged: 1, errors: 0 })
      expect(logWarn).toHaveBeenCalledWith('swap-cover', expect.stringContaining('timezone'), expect.objectContaining({ err: 'down' }))
    })
  })
})
