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
const { notifyOpenPool } = await import('./swap-cover-server')

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
  ? { data: { id: LOC, organization_id: ORG }, error: null }
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
      body: 'Coach R needs cover: Thu 24 Sep, 06:00 to 07:00. Tap to take it.',
      category: 'swap',
      emailSubject: 'A shift needs cover: Thu 24 Sep, 06:00 to 07:00',
      data: { type: 'swap_open_pool', swap_id: 'swap-1', block_date: '2026-09-24' },
    })
    expect(out).toEqual({ notified: 2, degraded: false })
  })

  it('reads leave by person, and that day\'s shifts ONLY at studios in the same organisation', async () => {
    const db = mockDb(healthy())
    await notifyOpenPool(db, ARGS)

    const [orgOf, orgStudios] = db.queries.filter((q) => q.table === 'locations')
    expect(orgOf.filters).toEqual([['eq', 'id', LOC]])
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
      expect(logWarn).toHaveBeenCalledWith('swap-cover', expect.stringContaining('members'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
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
      expect(logWarn).toHaveBeenCalledWith('swap-cover', expect.stringContaining('shifts'), expect.objectContaining({ swapId: 'swap-1', err: 'boom' }))
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
    expect(payload.body).toBe('A coach needs cover: Thu 24 Sep, 06:00 to 07:00. Tap to take it.')
    expect(payload.body).not.toContain('null')
  })

  it('does nothing without a block date', async () => {
    const db = mockDb(healthy())
    expect(await notifyOpenPool(db, { ...ARGS, block: { id: 'blk-1' } })).toEqual({ notified: 0, degraded: false })
    expect(db.queries).toHaveLength(0)
    expect(resolveRoleRecipientIds).not.toHaveBeenCalled()
  })
})
