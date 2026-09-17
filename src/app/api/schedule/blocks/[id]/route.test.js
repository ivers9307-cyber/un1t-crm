// SLOTREMOVAL.1 — DELETE /api/schedule/blocks/[id] remembers the removal.
//
// The nightly horizon generator upserts every date a template runs, so a
// deleted block used to be back by morning. The delete now writes a
// shift_block_removals row, which the generator and roster copies skip.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn((user) => (user.locations || []).map((l) => l.id)),
    // SCHEDROLES.1 — REAL: membership (404) and the role at the block's
    // studio (403) are both under test.
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})

vi.mock('@/lib/shift-unassign', () => ({ logAndNotifyUnassignments: vi.fn(async () => ({ logged: 1, notified: 1 })) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logWarn } = await import('@/lib/log')
const { logAndNotifyUnassignments } = await import('@/lib/shift-unassign')
const { DELETE } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const BLOCK = { id: 'blk-1', location_id: LOC, template_id: 'tpl-1', block_date: '2026-09-15' }

// SLOTNOTIFY.1 — `assignments` is who is on the slot when the delete lands;
// `assignmentsError` makes that read fail, which must refuse the delete rather
// than cascade away the only record of who to tell.
function makeDb({ block = BLOCK, deleteError = null, removalError = null, assignments = [], assignmentsError = null } = {}) {
  const captured = { deleted: null, removal: null, removalOpts: null, order: [] }
  const db = {
    captured,
    from(table) {
      if (table === 'shift_assignments') {
        return {
          select: () => ({
            eq: (col, val) => {
              captured.order.push('read-assignments')
              captured.assignmentsQuery = [col, val]
              return Promise.resolve({ data: assignmentsError ? null : assignments, error: assignmentsError })
            },
          }),
        }
      }
      if (table === 'shift_blocks') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve(block ? { data: block, error: null } : { data: null, error: { message: 'no rows' } }) }) }),
          delete: () => ({
            eq: (col, val) => {
              captured.deleted = [col, val]
              captured.order.push('delete')
              return Promise.resolve({ data: null, error: deleteError })
            },
          }),
        }
      }
      if (table === 'shift_block_removals') {
        return {
          upsert: (row, opts) => {
            captured.removal = row
            captured.removalOpts = opts
            captured.order.push('removal')
            return Promise.resolve({ data: null, error: removalError })
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const params = { params: Promise.resolve({ id: 'blk-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
})

describe('DELETE /api/schedule/blocks/[id] — SLOTREMOVAL.1', () => {
  it('deletes the block, then records the removal for its location, template and date', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.captured.deleted).toEqual(['id', 'blk-1'])
    expect(db.captured.order).toEqual(['delete', 'removal'])
    expect(db.captured.removal).toEqual({
      location_id: LOC, template_id: 'tpl-1', block_date: '2026-09-15', removed_by: 'mgr-1',
    })
    expect(db.captured.removalOpts).toEqual({ onConflict: 'location_id,template_id,block_date', ignoreDuplicates: true })
  })

  it('still reports success, with a warning, when the removal write fails (the block is gone either way)', async () => {
    const db = makeDb({ removalError: { message: 'removal boom' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.warning).toMatch(/nightly schedule may add it back/)
    expect(db.captured.deleted).toEqual(['id', 'blk-1'])
    expect(logWarn).toHaveBeenCalledWith('schedule-blocks', expect.any(String), expect.objectContaining({ blockId: 'blk-1' }))
  })

  it('records no removal when the delete itself fails', async () => {
    const db = makeDb({ deleteError: { message: 'fk boom' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    expect(res.status).toBe(400)
    expect(db.captured.removal).toBeNull()
  })

  it('404s an unknown block and a block at a studio the caller is not at, writing nothing', async () => {
    let db = makeDb({ block: null })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(404)
    expect(db.captured.order).toEqual([])

    db = makeDb({ block: { ...BLOCK, location_id: 'other-loc' } })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(404)
    expect(db.captured.order).toEqual([])
  })

  it('403s a non-manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 's', role: 'staff', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } })
    createServerClient.mockReturnValue(makeDb())
    expect((await DELETE({}, params)).status).toBe(403)
  })
})

// SCHEDROLES.1 — head coach at LOC, plain staff at LOC_B. The route used to
// read `user.role` (the ACTIVE studio's) and then check only membership, so
// this caller could delete LOC_B's slots from a LOC session.
describe('DELETE /api/schedule/blocks/[id] — role at the BLOCK\'s studio (SCHEDROLES.1)', () => {
  const LOC_B = 'b0000000-0000-0000-0000-000000000002'
  const mixed = (active) => ({
    id: 'mix', role: active === LOC ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: LOC }, { id: LOC_B }],
    rolesByLocation: { [LOC]: 'head_coach', [LOC_B]: 'staff' },
  })

  it('refuses a block at the studio where the caller is staff, and deletes nothing', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    const db = makeDb({ block: { ...BLOCK, location_id: LOC_B } })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(403)
    expect(db.captured.order).toEqual([])
  })

  it('allows a block at the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(200)
    expect(db.captured.order).toEqual(['delete', 'removal'])
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC_B))
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(200)
  })

  // getCurrentUser gives master every active location in `locations`.
  it('master is allowed at a studio with no membership row', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [{ id: LOC }, { id: LOC_B }], rolesByLocation: {} })
    const db = makeDb({ block: { ...BLOCK, location_id: LOC_B } })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(200)
  })
})

// SLOTNOTIFY.1 — deleting a STAFFED slot on a published roster told nobody:
// the FK cascade removed the assignments with no change-log row (so the
// re-publish safety net had nothing to find) and no message to the coaches.
describe('DELETE /api/schedule/blocks/[id] — SLOTNOTIFY.1', () => {
  const PUBLISHED = { ...BLOCK, roster_id: 'r-1', rosters: { status: 'published' } }
  const DRAFT = { ...BLOCK, roster_id: 'r-1', rosters: { status: 'draft' } }

  it('logs and notifies every live coach the cascade removed', async () => {
    const db = makeDb({
      block: PUBLISHED,
      assignments: [
        { id: 'a-1', profile_id: 'coach-1', status: 'scheduled' },
        { id: 'a-2', profile_id: 'coach-2', status: 'confirmed' },
      ],
    })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    expect(res.status).toBe(200)
    expect(logAndNotifyUnassignments).toHaveBeenCalledTimes(1)
    const [, args] = logAndNotifyUnassignments.mock.calls[0]
    expect(args.actorId).toBe('mgr-1')
    expect(args.assignments).toEqual([
      { id: 'a-1', profile_id: 'coach-1', block_id: 'blk-1', block_date: '2026-09-15', location_id: LOC, roster_status: 'published', details: { via: 'slot_deleted' } },
      { id: 'a-2', profile_id: 'coach-2', block_id: 'blk-1', block_date: '2026-09-15', location_id: LOC, roster_status: 'published', details: { via: 'slot_deleted' } },
    ])
  })

  it('reads the assignments BEFORE the delete and notifies BEFORE the removal record', async () => {
    // Order matters twice: the cascade destroys the rows that say who to tell,
    // and the slot-removal write can return early with a warning — a lost
    // tombstone must never cost the coaches their message.
    const db = makeDb({ block: PUBLISHED, assignments: [{ id: 'a-1', profile_id: 'coach-1', status: 'scheduled' }] })
    createServerClient.mockReturnValue(db)
    await DELETE({}, params)
    expect(db.captured.order).toEqual(['read-assignments', 'delete', 'removal'])
    const notifyCallOrder = logAndNotifyUnassignments.mock.invocationCallOrder[0]
    expect(notifyCallOrder).toBeGreaterThan(0)
  })

  it('still notifies when the slot-removal record fails', async () => {
    const db = makeDb({ block: PUBLISHED, assignments: [{ id: 'a-1', profile_id: 'coach-1', status: 'scheduled' }], removalError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await DELETE({}, params)
    expect(res.status).toBe(200)
    expect((await res.json()).warning).toMatch(/nightly schedule/i)
    expect(logAndNotifyUnassignments).toHaveBeenCalledTimes(1)
  })

  it('skips a cancelled assignment — it was not on the roster', async () => {
    const db = makeDb({
      block: PUBLISHED,
      assignments: [
        { id: 'a-1', profile_id: 'coach-1', status: 'cancelled' },
        { id: 'a-2', profile_id: 'coach-2', status: 'scheduled' },
      ],
    })
    createServerClient.mockReturnValue(db)
    await DELETE({}, params)
    expect(logAndNotifyUnassignments.mock.calls[0][1].assignments.map((x) => x.profile_id)).toEqual(['coach-2'])
  })

  it('never notifies for an empty slot', async () => {
    const db = makeDb({ block: PUBLISHED, assignments: [] })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(200)
    expect(logAndNotifyUnassignments).not.toHaveBeenCalled()
  })

  it('a DRAFT roster reads no assignments and notifies nobody', async () => {
    const db = makeDb({ block: DRAFT, assignments: [{ id: 'a-1', profile_id: 'coach-1', status: 'scheduled' }] })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(200)
    expect(db.captured.order).toEqual(['delete', 'removal'])
    expect(logAndNotifyUnassignments).not.toHaveBeenCalled()
  })

  it('an unreadable assignment list REFUSES the delete, destroying nothing', async () => {
    const db = makeDb({ block: PUBLISHED, assignmentsError: { message: 'connection reset' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, params)
    const json = await res.json()
    expect(res.status).toBe(503)
    expect(json.transient).toBe(true)
    expect(db.captured.deleted).toBeNull()
    expect(db.captured.removal).toBeNull()
    expect(logAndNotifyUnassignments).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalled()
  })

  it('does not notify when the block delete itself failed', async () => {
    const db = makeDb({ block: PUBLISHED, assignments: [{ id: 'a-1', profile_id: 'coach-1', status: 'scheduled' }], deleteError: { message: 'locked' } })
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, params)).status).toBe(400)
    expect(logAndNotifyUnassignments).not.toHaveBeenCalled()
  })
})
