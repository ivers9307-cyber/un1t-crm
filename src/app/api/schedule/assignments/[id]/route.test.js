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
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn().mockResolvedValue({ logged: true }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, getUserLocationIds } = await import('@/lib/auth')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { logRosterChange } = await import('@/lib/roster-change-log')
const { PUT, DELETE } = await import('./route.js')

const COACH = { id: 'coach-1', role: 'staff' }
const RECEPTION = { id: 'coach-2', role: 'reception' }
const MANAGER = { id: 'mgr-1', role: 'manager' }
const MASTER = { id: 'boss-1', role: 'master' }

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
function buildDb({ assignment = assignmentRow(), fetchErr = null, updateErr = null, deleteErr = null } = {}) {
  const updateSpy = vi.fn()
  const deleteSpy = vi.fn()
  return {
    updateSpy,
    deleteSpy,
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
            return {
              eq: () => ({
                select: () => ({
                  single: () => Promise.resolve({
                    data: updateErr ? null : {
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
                  }),
                }),
              }),
            }
          },
          delete: () => ({
            eq: (col, val) => { deleteSpy(col, val); return Promise.resolve({ error: deleteErr }) },
          }),
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
  logRosterChange.mockClear()
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
})
