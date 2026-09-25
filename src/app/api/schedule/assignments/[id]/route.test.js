// ROSTER-FIX.3 (D2, D3) — route-level contract tests for
// PUT / DELETE /api/schedule/assignments/[id].
//
// Richard's call (2026-09-09): a coach is paid for a window a manager set,
// and only a manager changes it; a coach cannot drop themselves off a shift
// either (that is a swap). Both handlers used to have an `isSelf` branch that
// let the assigned coach rewrite their own paid hours and delete their own
// assignment. These tests pin the manager-only gate, the per-location 404
// (the detail-route rule — a foreign location is invisible, not forbidden),
// and that a successful manager edit still pushes the affected coach.
//
// Supabase + auth + push are mocked; the mock pattern is the one in
// src/app/api/schedule/blocks/[id]/assignments/route.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn(() => ['loc-1']),
    // SCHEDROLES.1 — REAL: the role at the shift's studio is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn().mockResolvedValue({ logged: true }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/roster-change-notify', () => ({
  notifyRosterChanges: vi.fn(() => Promise.resolve({ notified: 0 })),
  markRosterChangesNotified: vi.fn(() => Promise.resolve()),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, getUserLocationIds } = await import('@/lib/auth')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { logRosterChange } = await import('@/lib/roster-change-log')
const { notifyRosterChanges, markRosterChangesNotified } = await import('@/lib/roster-change-notify')
const { PUT, DELETE } = await import('./route.js')

const COACH = { id: 'coach-1', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } }
const RECEPTION = { id: 'coach-2', role: 'reception', profileRole: 'staff', rolesByLocation: { 'loc-1': 'reception' } }
const MANAGER = { id: 'mgr-1', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } }
const MASTER = { id: 'boss-1', role: 'master', profileRole: 'master', rolesByLocation: {} }
// SCHEDROLES.1 — manager at loc-1, plain staff at loc-2. `role` is the ACTIVE
// studio's, which the route must not consult.
const mixed = (active) => ({
  id: 'mix-1', role: active === 'loc-1' ? 'manager' : 'staff', profileRole: 'staff',
  activeLocation: { id: active },
  rolesByLocation: { 'loc-1': 'manager', 'loc-2': 'staff' },
})

const PROPS = { params: Promise.resolve({ id: 'assign-1' }) }

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// The assignment the route reads before authorising. `locationId` is the
// parent block's location — the per-location gate compares it to
// getUserLocationIds(user).
function assignmentRow({
  locationId = 'loc-1',
  rosterStatus = 'published',
  profileId = COACH.id,
  startOverride = null,
  endOverride = null,
  partialReason = null,
} = {}) {
  return {
    id: 'assign-1',
    profile_id: profileId,
    block_id: 'block-1',
    start_time_override: startOverride,
    end_time_override: endOverride,
    partial_reason: partialReason,
    shift_blocks: {
      location_id: locationId,
      start_time: '09:00:00',
      end_time: '13:00:00',
      block_date: '2026-06-10',
      roster_id: 'roster-1',
      rosters: rosterStatus ? { status: rosterStatus } : null,
    },
  }
}

// Supabase mock over the single table this route touches. `updateSpy` and
// `deleteSpy` let a test assert the write never happened on a refused call.
// REPLACE.1a review 2 — `updateEqs` / `deleteEqs` record every .eq() on the
// write, and `changedUnder: true` answers the write with zero rows, as
// PostgREST does when the pinned profile no longer holds the row.
function buildDb({ assignment = assignmentRow(), fetchErr = null, updateErr = null, deleteErr = null, changedUnder = false } = {}) {
  const updateSpy = vi.fn()
  const deleteSpy = vi.fn()
  const updateEqs = []
  const deleteEqs = []
  return {
    updateSpy,
    deleteSpy,
    updateEqs,
    deleteEqs,
    db: {
      from: (table) => {
        if (table !== 'shift_assignments') throw new Error(`unexpected table ${table}`)
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: fetchErr ? null : assignment, error: fetchErr }),
            }),
          }),
          update: (patch) => {
            updateSpy(patch)
            const updated = () => Promise.resolve({
                    data: updateErr || changedUnder ? null : {
                      id: 'assign-1',
                      block_id: 'block-1',
                      profile_id: assignment?.profile_id ?? COACH.id,
                      status: 'scheduled',
                      start_time_override: patch.start_time_override ?? null,
                      end_time_override: patch.end_time_override ?? null,
                      partial_reason: patch.partial_reason ?? null,
                      shift_blocks: {
                        block_date: '2026-06-10',
                        start_time: '09:00:00',
                        end_time: '13:00:00',
                        shift_templates: { name: 'Morning' },
                      },
                    },
                    error: updateErr,
                  })
            const chain = {
              eq: (col, val) => { updateEqs.push([col, val]); return chain },
              select: () => ({ single: updated, maybeSingle: updated }),
            }
            return chain
          },
          delete: () => {
            const chain = {
              eq: (col, val) => { if (deleteEqs.length === 0) deleteSpy(col, val); deleteEqs.push([col, val]); return chain },
              select: () => Promise.resolve({ data: deleteErr || changedUnder ? [] : [{ id: 'assign-1' }], error: deleteErr }),
            }
            return chain
          },
        }
      },
    },
  }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  getUserLocationIds.mockReset()
  getUserLocationIds.mockReturnValue(['loc-1'])
  notifyUsersOnce.mockClear()
  notifyUsersOnce.mockResolvedValue(undefined)
  logRosterChange.mockClear()
  notifyRosterChanges.mockClear()
  markRosterChangesNotified.mockClear()
})

describe('PUT /api/schedule/assignments/[id] — hours are manager-set (D3)', () => {
  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(res.status).toBe(401)
  })

  it('403s a coach editing their OWN assignment, and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    const { db, updateSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(403)
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/only a manager can change shift hours/i)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('403s a non-manager (reception) editing someone else', async () => {
    getCurrentUser.mockResolvedValue(RECEPTION)
    const { db, updateSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ end_time_override: '12:00:00' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('lets a manager at the shift’s location adjust it, and pushes the coach', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, updateSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ start_time_override: '10:00:00', end_time_override: '12:00:00' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual([COACH.id])
  })

  // SCHEDSTATUS.1 — the PUT used to accept 'declined', which
  // shift_assignments_status_check (mig 067/337) rejects: the write reached
  // Postgres and came back as a 400 naming a constraint.
  it('400s a status the database would refuse, before touching the DB', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, updateSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ status: 'declined' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.success).toBe(false)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('accepts a status the database allows', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, updateSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ status: 'confirmed' }), PROPS)
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ status: 'confirmed' })
  })

  it('404s a manager whose locations do not include the shift’s location', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    getUserLocationIds.mockReturnValue(['loc-2'])
    const { db, updateSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('lets master adjust an assignment at any location', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    getUserLocationIds.mockReturnValue([])
    const { db, updateSpy } = buildDb({ assignment: assignmentRow({ locationId: 'loc-9' }) })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  // ROSTER-FIX.3a2 — the edit form posts every override field back on save,
  // so "the key is in the body" is not "the value moved". A re-save of the
  // same times must not push the coach and must not write a `time_changed`
  // row, which is what makes the next re-publish re-notify them.
  it('does not push or log when a manager re-saves identical override times', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, updateSpy } = buildDb({
      assignment: assignmentRow({ startOverride: '10:00:00', endOverride: '12:00:00' }),
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({
      start_time_override: '10:00:00',
      end_time_override: '12:00:00',
      partial_reason: null,
    }), PROPS)
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(logRosterChange).not.toHaveBeenCalled()
  })

  it('pushes and logs when one override value really changes', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb({
      assignment: assignmentRow({ startOverride: '10:00:00', endOverride: '12:00:00' }),
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({
      start_time_override: '10:00:00',
      end_time_override: '13:00:00',
    }), PROPS)
    expect(res.status).toBe(200)
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(logRosterChange.mock.calls[0][1]).toMatchObject({ action: 'time_changed' })
  })

  // A manager who works the shift they are editing notifies themselves. That
  // is accepted: the alternative is an isSelf branch, and ROSTER-FIX.3 deleted
  // those because they were how a coach edited their own paid hours. Pinned so
  // nobody "fixes" it back into a special case.
  it('still pushes when a manager edits their OWN assignment', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb({ assignment: assignmentRow({ profileId: MANAGER.id }) })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ end_time_override: '12:00:00' }), PROPS)
    expect(res.status).toBe(200)
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual([MANAGER.id])
  })

  // ROSTER-FIX.3a2 — the gate used to be `if (blockLocation && !owned)`, which
  // fell OPEN on a block with no location_id: unscopeable is not the same as
  // permitted.
  it('404s a non-master manager on a block with no location_id', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, updateSpy } = buildDb({ assignment: assignmentRow({ locationId: null }) })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('still logs the change on a published roster', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)

    await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(logRosterChange.mock.calls[0][1]).toMatchObject({ action: 'time_changed', coachId: COACH.id })
  })

  // NOTIFY.1 review — a delivered push already told the coach; the
  // `time_changed` row it just wrote must be stamped so a later
  // re-publish/approve doesn't send them a second message about it.
  it('stamps the time_changed row when notifyUsersOnce reports delivery', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    notifyUsersOnce.mockResolvedValue({ sent: 1, emailed: 0 })
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)

    await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(markRosterChangesNotified).toHaveBeenCalledWith(db, {
      locationId: 'loc-1',
      coachId: COACH.id,
      blockIds: ['block-1'],
      action: 'time_changed',
    })
  })

  it('does not stamp when notifyUsersOnce delivers nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    notifyUsersOnce.mockResolvedValue({ sent: 0, emailed: 0 })
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)

    await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(markRosterChangesNotified).not.toHaveBeenCalled()
  })

  // NOTIFY.1 review — a dedup hit means notifyUsersOnce found an existing
  // claim for this SAME key (identical override values), not that THIS
  // change was delivered — e.g. an A→B→A round trip lands back on a key it
  // already claimed, or the claim itself is a quiet no-op. It must not stamp.
  it('does not stamp on a dedup hit alone', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    notifyUsersOnce.mockResolvedValue({ sent: 0, emailed: 0, deduped: 1 })
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)

    await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(markRosterChangesNotified).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/schedule/assignments/[id] — a coach cannot drop themselves (D2)', () => {
  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await DELETE({}, PROPS)
    expect(res.status).toBe(401)
  })

  it('403s a coach removing their OWN assignment, and deletes nothing', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    const { db, deleteSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, PROPS)
    const json = await res.json()
    expect(res.status).toBe(403)
    expect(json.error).toMatch(/swap/i)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('lets a manager at the shift’s location remove a coach', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, deleteSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, PROPS)
    expect(res.status).toBe(200)
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(logRosterChange.mock.calls[0][1]).toMatchObject({ action: 'unassigned', coachId: COACH.id })
  })

  it('404s a manager whose locations do not include the shift’s location', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    getUserLocationIds.mockReturnValue(['loc-2'])
    const { db, deleteSpy } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, PROPS)
    expect(res.status).toBe(404)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  // ROSTER-FIX.3a2 — same fail-open gate as the PUT side.
  it('404s a non-master manager on a block with no location_id', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, deleteSpy } = buildDb({ assignment: assignmentRow({ locationId: null }) })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, PROPS)
    expect(res.status).toBe(404)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('404s when the assignment does not exist', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, deleteSpy } = buildDb({ fetchErr: { message: 'no rows' } })
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, PROPS)
    expect(res.status).toBe(404)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('tells the removed coach immediately when the roster is published (NOTIFY.1)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE({}, PROPS)
    expect(res.status).toBe(200)
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges.mock.calls[0][1]).toEqual({
      locationId: 'loc-1',
      actorId: MANAGER.id,
      changes: [{ coachId: COACH.id, blockId: 'block-1', blockDate: '2026-06-10', action: 'unassigned' }],
    })
  })

  it('does not notify when the roster is a draft', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb({ assignment: assignmentRow({ rosterStatus: 'draft' }) })
    createServerClient.mockReturnValue(db)

    await DELETE({}, PROPS)
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })

  it('PUT time changes do not go through notifyRosterChanges (they push shift_adjusted themselves)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb()
    createServerClient.mockReturnValue(db)

    await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })
})

// REPLACE.1a review 2 — a replace hands the row to another coach under the
// same id. A write read as "Coach A's row" must not land on Coach B: both
// writes are pinned to the coach that was read, and zero rows is 409.
describe('PUT / DELETE /api/schedule/assignments/[id] — pinned to the coach that was read (review 2)', () => {
  it('PUT updates by id AND the profile it read', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, updateEqs } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ start_time_override: '10:00:00' }), PROPS)).status).toBe(200)
    expect(updateEqs).toEqual([['id', 'assign-1'], ['profile_id', COACH.id]])
  })

  it('PUT: the row changed hands meanwhile (zero rows) is 409, nobody pushed, nothing logged', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb({ changedUnder: true })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ start_time_override: '10:00:00' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This shift has just changed. Refresh and try again.')
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(logRosterChange).not.toHaveBeenCalled()
  })

  it('DELETE removes by id AND the profile it read', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db, deleteEqs } = buildDb()
    createServerClient.mockReturnValue(db)
    expect((await DELETE({}, PROPS)).status).toBe(200)
    expect(deleteEqs).toEqual([['id', 'assign-1'], ['profile_id', COACH.id]])
  })

  it('DELETE: the row changed hands meanwhile is 409, nothing logged, nobody told', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const { db } = buildDb({ changedUnder: true })
    createServerClient.mockReturnValue(db)
    const res = await DELETE({}, PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This shift has just changed. Refresh and try again.')
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })
})

describe('PUT / DELETE /api/schedule/assignments/[id] — role at the SHIFT\'s studio (SCHEDROLES.1)', () => {
  beforeEach(() => { getUserLocationIds.mockReturnValue(['loc-1', 'loc-2']) })

  it('refuses a manager-at-A acting on a shift at B, where they are staff (403, nothing written)', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const put = buildDb({ assignment: assignmentRow({ locationId: 'loc-2' }) })
    createServerClient.mockReturnValue(put.db)
    const res = await PUT(req({ start_time_override: '10:00' }), PROPS)
    expect(res.status).toBe(403)
    expect(put.updateSpy).not.toHaveBeenCalled()

    const del = buildDb({ assignment: assignmentRow({ locationId: 'loc-2' }) })
    createServerClient.mockReturnValue(del.db)
    const res2 = await DELETE(req(), PROPS)
    expect(res2.status).toBe(403)
    expect(del.deleteSpy).not.toHaveBeenCalled()
  })

  it('allows the same caller on a shift at A', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const put = buildDb({ assignment: assignmentRow({ locationId: 'loc-1' }) })
    createServerClient.mockReturnValue(put.db)
    expect((await PUT(req({ start_time_override: '10:00' }), PROPS)).status).toBe(200)
    const del = buildDb({ assignment: assignmentRow({ locationId: 'loc-1' }) })
    createServerClient.mockReturnValue(del.db)
    expect((await DELETE(req(), PROPS)).status).toBe(200)
  })

  it('still allows a shift at A with the ACTIVE studio set to B, where they are staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-2'))
    const put = buildDb({ assignment: assignmentRow({ locationId: 'loc-1' }) })
    createServerClient.mockReturnValue(put.db)
    expect((await PUT(req({ start_time_override: '10:00' }), PROPS)).status).toBe(200)
    const del = buildDb({ assignment: assignmentRow({ locationId: 'loc-1' }) })
    createServerClient.mockReturnValue(del.db)
    expect((await DELETE(req(), PROPS)).status).toBe(200)
  })

  it('master is allowed at any studio', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    getUserLocationIds.mockReturnValue([])
    const del = buildDb({ assignment: assignmentRow({ locationId: 'loc-2' }) })
    createServerClient.mockReturnValue(del.db)
    expect((await DELETE(req(), PROPS)).status).toBe(200)
  })
})
