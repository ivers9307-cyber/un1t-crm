// LEAVE.1 — unassignShiftAssignments is the delete + change-log + NOTIFY.1
// path shared by DELETE /api/schedule/assignments/[id] and the leave-clash
// "Unassign them" action.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/roster-change-notify', () => ({ notifyRosterChanges: vi.fn(async () => ({ notified: 1 })) }))

const { logRosterChange } = await import('@/lib/roster-change-log')
const { notifyRosterChanges } = await import('@/lib/roster-change-notify')
const { unassignShiftAssignments, logAndNotifyUnassignments } = await import('./shift-unassign.js')
const { fakeDb, queriesOf } = await import('./time-off.test-helpers.js')

const a = (id, location_id, roster_status = 'published', block_date = '2026-06-01') =>
  ({ id, profile_id: 'coach', block_id: `b-${id}`, block_date, location_id, roster_status })

beforeEach(() => vi.clearAllMocks())

describe('unassignShiftAssignments', () => {
  it('deletes each row, logs published ones, and notifies once per studio', async () => {
    const db = fakeDb((q) => ({ data: [{ id: q.eq.id }], error: null }))
    const out = await unassignShiftAssignments(db, {
      actorId: 'mgr',
      assignments: [a('1', 'loc-1'), a('2', 'loc-1', 'published', '2026-06-02'), a('3', 'loc-2', 'draft')],
    })
    expect(queriesOf(db, 'shift_assignments', 'delete').map((q) => q.eq.id)).toEqual(['1', '2', '3'])
    expect(out.removed.map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(logRosterChange).toHaveBeenCalledTimes(2)
    expect(logRosterChange.mock.calls[0][1]).toMatchObject({ action: 'unassigned', coachId: 'coach', actorId: 'mgr', locationId: 'loc-1' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges.mock.calls[0][1]).toMatchObject({ locationId: 'loc-1', actorId: 'mgr' })
    expect(notifyRosterChanges.mock.calls[0][1].changes).toHaveLength(2)
  })

  it('a failed delete is reported and neither logged nor notified; the others still go', async () => {
    const db = fakeDb((q) => (q.eq.id === '1' ? { error: { message: 'locked' } } : { data: [{ id: q.eq.id }], error: null }))
    const out = await unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1'), a('2', 'loc-1')] })
    expect(out.failed).toEqual([{ id: '1', error: 'locked' }])
    expect(out.removed.map((r) => r.id)).toEqual(['2'])
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges.mock.calls[0][1].changes.map((c) => c.blockId)).toEqual(['b-2'])
  })
})

// REPLACE.1a review 2 — a replace moves a row to ANOTHER coach under the same
// id. A delete read as "coach A's row" must not remove coach B, who holds the
// row now: it is pinned to the coach it was read for, and zero rows is
// "changed", neither logged nor notified (nobody was taken off anything).
describe('unassignShiftAssignments — pinned to the coach it read (review 2)', () => {
  it('deletes by id AND profile_id, and judges the rows it removed', async () => {
    const db = fakeDb((q) => ({ data: [{ id: q.eq.id }], error: null }))
    await unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1')] })
    const [del] = queriesOf(db, 'shift_assignments', 'delete')
    expect(del.eq).toEqual({ id: '1', profile_id: 'coach' })
    expect(del.columns).toBe('id')
  })

  it('zero rows (the row now belongs to someone else, or is gone) is failed "changed": not logged, not notified', async () => {
    const db = fakeDb(() => ({ data: [], error: null }))
    const out = await unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1')] })
    expect(out).toEqual({ removed: [], failed: [{ id: '1', error: 'This shift has just changed. Refresh and try again.', code: 'changed' }] })
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })
})

// SLOTNOTIFY.1 — the audit + notification half on its own, for callers whose
// DELETE cascades (DELETE /api/schedule/blocks/[id] takes the assignments with
// the block, so there is no per-row delete to hang this off).
describe('logAndNotifyUnassignments', () => {
  const db = { /* never touched: both collaborators are mocked */ }

  it('logs and notifies only the PUBLISHED removals, grouped per studio', async () => {
    const out = await logAndNotifyUnassignments(db, {
      actorId: 'mgr',
      assignments: [a('1', 'loc-1'), a('2', 'loc-1', 'published', '2026-06-02'), a('3', 'loc-2', 'draft')],
    })
    expect(out).toEqual({ logged: 2, notified: 1 })
    expect(logRosterChange).toHaveBeenCalledTimes(2)
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges.mock.calls[0][1]).toMatchObject({ locationId: 'loc-1', actorId: 'mgr' })
    expect(notifyRosterChanges.mock.calls[0][1].changes).toEqual([
      { coachId: 'coach', blockId: 'b-1', blockDate: '2026-06-01', action: 'unassigned' },
      { coachId: 'coach', blockId: 'b-2', blockDate: '2026-06-02', action: 'unassigned' },
    ])
  })

  it('does nothing at all when no removal was on a published roster', async () => {
    const out = await logAndNotifyUnassignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1', 'draft')] })
    expect(out).toEqual({ logged: 0, notified: 0 })
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })

  it('passes a caller-supplied `details` through to the change-log row', async () => {
    await logAndNotifyUnassignments(db, {
      actorId: 'mgr',
      assignments: [{ ...a('1', 'loc-1'), details: { via: 'slot_deleted' } }],
    })
    expect(logRosterChange.mock.calls[0][1]).toMatchObject({ details: { via: 'slot_deleted' } })
  })

  it('tolerates an empty / missing list', async () => {
    expect(await logAndNotifyUnassignments(db, { actorId: 'mgr', assignments: [] })).toEqual({ logged: 0, notified: 0 })
    expect(await logAndNotifyUnassignments(db, { actorId: 'mgr' })).toEqual({ logged: 0, notified: 0 })
  })
})
