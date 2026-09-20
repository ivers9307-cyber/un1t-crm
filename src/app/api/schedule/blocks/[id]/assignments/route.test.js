// SCHEDULE-MULTI-COACH.1 — route-level contract tests for
// POST /api/schedule/blocks/[id]/assignments.
//
// We mock Supabase + auth so the route runs in isolation. The route
// has two modes (legacy single profile_id, new profile_ids[]); the
// tests lock the per-mode response shape, the capacity / already-
// assigned skip reasons, and the auth gate.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn(),
    // SCHEDROLES.1 — REAL: membership (404) and the role at the block's
    // studio (403) are both under test.
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-change-notify', () => ({ notifyRosterChanges: vi.fn(() => Promise.resolve({ notified: 0 })) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, getUserLocationIds } = await import('@/lib/auth')
const { POST } = await import('./route.js')
const { notifyRosterChanges } = await import('@/lib/roster-change-notify')

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  getUserLocationIds.mockReset()
  notifyRosterChanges.mockClear()
})

function req(body) {
  return {
    json: () => Promise.resolve(body),
    headers: { get: () => '' },
  }
}

const PROPS = { params: Promise.resolve({ id: 'block-1' }) }

// Build a Supabase mock backed by per-table behaviour. Each table
// returns a thenable chain whose terminal resolves to the canned
// value. Inserts get a spy so tests can assert call counts + the
// rows passed in.
function buildDb({
  block,
  blockErr = null,
  existingAssignedIds = [],
  // ROSTER-FIX.1 — richer form of existingAssignedIds: full
  // { profile_id, status } rows, so a test can seed a cancelled tombstone.
  existingAssigned = null,
  // ROSTER-FIX.1 — force the existing-assignees read to fail.
  existingAssignsErr = null,
  timeOff = [],
  insertErrorFor = () => null, // (profileId) → error or null
  // SCHEDROLES.1 — profile ids on the block's studio; null = every one asked.
  membersHere = null,
  membersErr = null,
  // STAFFDELETE.1 — profiles rows for the rosterable check; an id not listed
  // is an active, living coach, so earlier tests keep their meaning.
  people = [],
  peopleErr = null,
}) {
  const insertSpy = vi.fn()
  const deleteSpy = vi.fn()
  const timeOffSpy = vi.fn()
  const existingRows = existingAssigned
    ?? existingAssignedIds.map((id) => ({ id: `assign-${id}`, profile_id: id, status: 'scheduled' }))
  return {
    insertSpy,
    deleteSpy,
    timeOffSpy,
    db: {
      from: (table) => {
        if (table === 'profiles') {
          return { select: () => ({ in: (_c, ids) => Promise.resolve(peopleErr
            ? { data: null, error: peopleErr }
            : { data: ids.map((id) => people.find((x) => x.id === id) || { id, full_name: 'Coach', active: true, deleted_at: null }), error: null }) }) }
        }
        if (table === 'profile_locations') {
          return {
            select: () => ({
              eq: (col, loc) => ({
                in: (_c, ids) => Promise.resolve(membersErr
                  ? { data: null, error: membersErr }
                  : {
                    data: ids.filter((id) => !membersHere || membersHere.includes(id)).map((profile_id) => ({ profile_id, location_id: loc })),
                    error: null,
                  }),
              }),
            }),
          }
        }
        if (table === 'shift_blocks') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: block, error: blockErr }),
              }),
            }),
          }
        }
        if (table === 'shift_assignments') {
          return {
            select: (sel) => {
              // Existing-assignees lookup (early in the route).
              if (sel === 'id, profile_id, status') {
                return {
                  eq: () => Promise.resolve(existingAssignsErr
                    ? { data: null, error: existingAssignsErr }
                    : {
                      data: existingRows.map((r) => ({ id: r.id ?? `assign-${r.profile_id}`, profile_id: r.profile_id, status: r.status ?? 'scheduled' })),
                      error: null,
                    }),
                }
              }
              // The post-insert .select() — shouldn't be called this way.
              throw new Error(`unexpected shift_assignments.select(${sel})`)
            },
            // ROSTER-FIX.1 — the tombstone clear before a re-assign.
            delete: () => ({
              eq: (col, val) => { deleteSpy(col, val); return Promise.resolve({ error: null }) },
            }),
            insert: (row) => {
              insertSpy(row)
              const err = insertErrorFor(row.profile_id)
              return {
                select: () => ({
                  single: () => Promise.resolve({
                    data: err ? null : { id: `assign-${row.profile_id}`, ...row },
                    error: err,
                  }),
                }),
              }
            },
          }
        }
        if (table === 'time_off_requests') {
          timeOffSpy()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  lte: () => ({
                    gte: () => Promise.resolve({ data: timeOff, error: null }),
                  }),
                }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
    },
  }
}

// getCurrentUser gives master every active location in `locations`.
const MASTER = { id: 'u1', role: 'master', profileRole: 'master', locations: [{ id: 'loc-1' }, { id: 'loc-2' }], rolesByLocation: {} }
const STAFF = { id: 'u2', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } }

describe('POST /api/schedule/blocks/[id]/assignments — auth + validation', () => {
  it('403 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ profile_id: '11111111-1111-1111-1111-111111111111' }), PROPS)
    expect(res.status).toBe(403)
  })

  it('403 when caller is not a manager', async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    const res = await POST(req({ profile_id: '11111111-1111-1111-1111-111111111111' }), PROPS)
    expect(res.status).toBe(403)
  })

  it('400 when both profile_id and profile_ids are sent', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(req({
      profile_id: '11111111-1111-1111-1111-111111111111',
      profile_ids: ['22222222-2222-2222-2222-222222222222'],
    }), PROPS)
    expect(res.status).toBe(400)
  })

  it('400 when neither profile_id nor profile_ids is sent', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(400)
  })
})

describe('POST — multi-coach (profile_ids)', () => {
  it('assigns every coach when there is capacity', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5 },
    })
    createServerClient.mockReturnValue(db)

    const ids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc']
    const res = await POST(req({ profile_ids: ids }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.assigned).toHaveLength(3)
    expect(json.skipped).toEqual([])
    expect(insertSpy).toHaveBeenCalledTimes(3)
  })

  it('skips coaches beyond capacity (at_capacity)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      // max=3, currently 1 → 2 slots open.
      // ROSTER-FIX.1 — capacity is now counted from the LIVE assignment rows,
      // not a shift_assignments(count) embed, so an occupied seat is seeded as
      // a real assignee rather than a phantom count.
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 3 },
      existingAssignedIds: ['99999999-9999-9999-9999-999999999999'],
    })
    createServerClient.mockReturnValue(db)

    const ids = [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'cccccccc-cccc-cccc-cccc-cccccccccccc', // overflow
      'dddddddd-dddd-dddd-dddd-dddddddddddd', // overflow
    ]
    const res = await POST(req({ profile_ids: ids }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(2)
    expect(json.skipped).toHaveLength(2)
    expect(json.skipped.every((s) => s.reason === 'at_capacity')).toBe(true)
  })

  it('allow_over_capacity bypasses the cap', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      // ROSTER-FIX.1 — capacity is now counted from the LIVE assignment rows,
      // not a shift_assignments(count) embed, so an occupied seat is seeded as
      // a real assignee rather than a phantom count.
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 1 },
      existingAssignedIds: ['99999999-9999-9999-9999-999999999999'],
    })
    createServerClient.mockReturnValue(db)

    const ids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']
    const res = await POST(req({ profile_ids: ids, allow_over_capacity: true }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(2)
    expect(json.skipped).toEqual([])
  })

  it('silently skips coaches who are already on the block', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const dupId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, shift_assignments: [{ count: 1 }] },
      existingAssignedIds: [dupId],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_ids: [dupId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'] }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(1)
    expect(json.skipped).toEqual([{ profile_id: dupId, reason: 'already_assigned' }])
  })

  it('dedupes a duplicated id in the request payload', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5 },
    })
    createServerClient.mockReturnValue(db)

    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const res = await POST(req({ profile_ids: [id, id, id] }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(1)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })
})

describe('POST — legacy single-coach (profile_id) response shape', () => {
  it('returns { data } on success', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5 },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.data).toBeDefined()
    expect(json.assigned).toBeUndefined()
  })

  it('returns 409 with the legacy at-capacity message', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      // ROSTER-FIX.1 — capacity is now counted from the LIVE assignment rows,
      // not a shift_assignments(count) embed, so an occupied seat is seeded as
      // a real assignee rather than a phantom count.
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 1 },
      existingAssignedIds: ['99999999-9999-9999-9999-999999999999'],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/at capacity/i)
  })

  it('returns 409 with the legacy already-assigned message', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const dupId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, shift_assignments: [{ count: 1 }] },
      existingAssignedIds: [dupId],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_id: dupId }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).toMatch(/already assigned/i)
  })
})

// ROSTER-FIX.1 (D4) — an approved swap-drop used to leave a `status:
// cancelled` row behind. It kept the block looking staffed (capacity) and the
// (block, profile) unique key refused to re-add the same coach.
describe('POST — cancelled tombstones', () => {
  it('lets a coach whose earlier assignment was cancelled be assigned again, and does not count the tombstone toward capacity', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 1, start_time: null, end_time: null, roster_id: null, rosters: null },
      existingAssigned: [{ profile_id: '11111111-1111-1111-1111-111111111111', status: 'cancelled' }],
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ profile_id: '11111111-1111-1111-1111-111111111111' }), PROPS)
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })
})

// ROSTER-FIX.1 — the existing-assignees read used to discard its error, so a
// failed read looked like an empty block: capacity unenforced, nobody
// already-assigned, no tombstones. It must fail the request instead.
describe('POST — existing-assignees query failure', () => {
  it('400s and inserts nothing when the existing-assignees read errors', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 1 },
      existingAssignsErr: { message: 'boom' },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_ids: [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ] }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.success).toBe(false)
    expect(json.error).toBe('boom')
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

describe('POST — tells coaches added to a PUBLISHED shift (NOTIFY.1)', () => {
  const ids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']

  it('notifies every newly assigned coach when the block is on a published roster', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, rosters: { status: 'published' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_ids: ids }), PROPS)
    expect(res.status).toBe(201)
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    const [, opts] = notifyRosterChanges.mock.calls[0]
    expect(opts).toMatchObject({ locationId: 'loc-1', actorId: 'u1' })
    expect(opts.changes).toEqual(ids.map((coachId) => ({ coachId, blockId: 'block-1', blockDate: '2026-06-01', action: 'assigned' })))
  })

  it('does not notify when the block is not on a published roster', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({ block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5 } })
    createServerClient.mockReturnValue(db)

    await POST(req({ profile_ids: ids }), PROPS)
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })

  it('omits an already-assigned coach from the notified changes, but still notifies the newly assigned one', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const [alreadyId, newId] = ids
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, rosters: { status: 'published' } },
      existingAssignedIds: [alreadyId],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_ids: ids }), PROPS)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.assigned).toHaveLength(1)
    expect(json.skipped).toEqual([{ profile_id: alreadyId, reason: 'already_assigned' }])
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    const [, opts] = notifyRosterChanges.mock.calls[0]
    expect(opts.changes).toEqual([{ coachId: newId, blockId: 'block-1', blockDate: '2026-06-01', action: 'assigned' }])
  })
})

// SCHEDROLES.1 — head coach at loc-1, plain staff at loc-2. The route used to
// read `user.role` (the ACTIVE studio's) and then check only membership.
describe('POST — role at the BLOCK\'s studio (SCHEDROLES.1)', () => {
  const mixed = (active) => ({
    id: 'mix', role: active === 'loc-1' ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
    rolesByLocation: { 'loc-1': 'head_coach', 'loc-2': 'staff' },
  })
  const block = (loc) => ({ id: 'block-1', location_id: loc, block_date: '2026-06-01', max_coaches: 5 })
  const IDS = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']

  it('refuses a block at the studio where the caller is staff, and inserts nothing', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, insertSpy } = buildDb({ block: block('loc-2') })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ profile_ids: IDS }), PROPS)
    expect(res.status).toBe(403)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('allows a block at the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, insertSpy } = buildDb({ block: block('loc-1') })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ profile_ids: IDS }), PROPS)).status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-2'))
    const { db } = buildDb({ block: block('loc-1') })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ profile_ids: IDS }), PROPS)).status).toBe(201)
  })

  it('a head coach who is not at the block\'s studio at all gets 404', async () => {
    getCurrentUser.mockResolvedValue({ id: 'hc', role: 'head_coach', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'head_coach' } })
    const { db, insertSpy } = buildDb({ block: block('loc-9') })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ profile_ids: IDS }), PROPS)).status).toBe(404)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

// SCHEDROLES.1 — only a coach on the block's studio can be put on it, master
// included, checked before any leave or double-booking read and the insert.
describe('POST — coach must be at the block\'s studio (SCHEDROLES.1)', () => {
  const HERE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const AWAY = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const blk = { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5 }
  const awayLeave = [{ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-01', profiles: { full_name: 'Away Person' } }]

  it('single assign of a coach from another studio: 400, no leave read, no insert (master too)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy, timeOffSpy } = buildDb({ block: blk, membersHere: [HERE], timeOff: awayLeave })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ profile_id: AWAY }), PROPS)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/not on the staff of this studio/)
    expect(JSON.stringify(json)).not.toContain('Away Person')
    expect(insertSpy).not.toHaveBeenCalled()
    expect(timeOffSpy).not.toHaveBeenCalled()
  })

  it('multi assign skips the foreign coach as not_at_location and assigns the one who is here', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({ block: blk, membersHere: [HERE] })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ profile_ids: [HERE, AWAY] }), PROPS)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.assigned.map((a) => a.profile_id)).toEqual([HERE])
    expect(json.skipped).toEqual([{ profile_id: AWAY, reason: 'not_at_location' }])
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('fails closed (500, nothing inserted) when the membership read errors', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({ block: blk, membersErr: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ profile_ids: [HERE] }), PROPS)).status).toBe(500)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

// STAFFDELETE.1 review A — the same rule as every other write path
// (isRosterableProfile): a deactivated coach who is still linked to the studio
// cannot be put on a shift by hand.
describe('POST — a deactivated coach cannot be assigned', () => {
  const OFF = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const ON = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const block = { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5 }
  const people = [{ id: OFF, full_name: 'Former Coach', active: false, deleted_at: null }]

  it('multi: skipped as not_rosterable, the active coach is still assigned', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({ block, people })
    createServerClient.mockReturnValue(db)
    const json = await (await POST(req({ profile_ids: [ON, OFF] }), PROPS)).json()
    expect(json.assigned.map((a) => a.profile_id)).toEqual([ON])
    expect(json.skipped).toEqual([{ profile_id: OFF, reason: 'not_rosterable' }])
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('legacy single: 400 with what to do about it, nothing inserted', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({ block, people })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ profile_id: OFF }), PROPS)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Former Coach is deactivated and cannot be rostered. Reactivate them in Settings > Staff first.')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('fails closed (500, nothing inserted) when the profiles read errors', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({ block, peopleErr: { message: 'down' } })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ profile_ids: [ON] }), PROPS)).status).toBe(500)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
