// LEAVE.1 — unassignShiftAssignments is the delete + change-log + NOTIFY.1
// path shared by DELETE /api/schedule/assignments/[id] and the leave-clash
// "Unassign them" action.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/roster-change-notify', () => ({ notifyRosterChanges: vi.fn(async () => ({ notified: 1 })) }))

const { logRosterChange } = await import('@/lib/roster-change-log')
const { notifyRosterChanges } = await import('@/lib/roster-change-notify')
const { unassignShiftAssignments, logAndNotifyUnassignments, SHIFT_CHANGED_ERROR, SHIFTS_CHANGED_ERROR } = await import('./shift-unassign.js')
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

  it('zero rows and the row is still there (it belongs to someone else now) is failed "changed": not logged, not notified', async () => {
    // The zero-row delete answers [], and so does the re-read here: a row is
    // still there under that id.
    const db = fakeDb(() => ({ data: [], error: null }))
    const out = await unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1')] })
    expect(out).toEqual({ removed: [], failed: [{ id: '1', error: 'This shift has just changed. Refresh and try again.', code: 'changed' }], gone: [] })
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

// C5 REPLACENITS.1 — a zero-row delete has two meanings. The row is GONE (a
// double submit's other request, another manager, or the slot's cascade took
// it): the caller's wish is met, and whoever deleted it logged and told the
// coach. Or it is still there under ANOTHER coach (a replace won; review 2):
// "changed", as before. One re-read by id tells them apart. An unreadable
// re-read is "changed" (today's answer, a refresh), never a guessed success.
describe('unassignShiftAssignments — gone is done, changed hands is "changed" (REPLACENITS.1)', () => {
  const CHANGED = { id: '1', error: 'This shift has just changed. Refresh and try again.', code: 'changed' }
  const dbWith = (reread) => fakeDb((q) => {
    if (q.action === 'delete') return { data: [], error: null }
    if (q.table === 'shift_assignments' && q.action === 'select') return typeof reread === 'function' ? reread(q) : reread
    return { data: null, error: null }
  })

  it('the row no longer exists: gone, not failed; nothing logged or told a second time', async () => {
    const db = dbWith({ data: null, error: null })
    const out = await unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1')] })
    expect(out).toEqual({ removed: [], failed: [], gone: [a('1', 'loc-1')] })
    const [read] = queriesOf(db, 'shift_assignments', 'select')
    expect(read.eq).toEqual({ id: '1' })
    expect(read.columns).toBe('id')
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })

  it('the row is still there under another coach (a replace won): changed, as before', async () => {
    const out = await unassignShiftAssignments(dbWith({ data: { id: '1' }, error: null }), { actorId: 'mgr', assignments: [a('1', 'loc-1')] })
    expect(out).toEqual({ removed: [], failed: [CHANGED], gone: [] })
    expect(SHIFT_CHANGED_ERROR).toBe(CHANGED.error)
  })

  it('the re-read fails: changed (the caller refreshes), never a guess that it went', async () => {
    const out = await unassignShiftAssignments(dbWith({ data: null, error: { message: 'down' } }), { actorId: 'mgr', assignments: [a('1', 'loc-1')] })
    expect(out).toEqual({ removed: [], failed: [CHANGED], gone: [] })
  })

  it('a re-read that throws is changed too, and the helper still resolves', async () => {
    const db = dbWith(() => { throw new Error('socket closed') })
    await expect(unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1')] }))
      .resolves.toEqual({ removed: [], failed: [CHANGED], gone: [] })
  })

  it('a mixed batch: removed, gone and changed each land in their own list; only the removed one is logged and told', async () => {
    const db = fakeDb((q) => {
      if (q.action === 'delete') return q.eq.id === '1' ? { data: [{ id: '1' }], error: null } : { data: [], error: null }
      if (q.action === 'select') return q.eq.id === '2' ? { data: null, error: null } : { data: { id: q.eq.id }, error: null }
      return { data: null, error: null }
    })
    const out = await unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1'), a('2', 'loc-1'), a('3', 'loc-1')] })
    expect(out.removed.map((r) => r.id)).toEqual(['1'])
    expect(out.gone.map((r) => r.id)).toEqual(['2'])
    expect(out.failed).toEqual([{ ...CHANGED, id: '3' }])
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges.mock.calls[0][1].changes.map((c) => c.blockId)).toEqual(['b-1'])
  })

  it('the plural words exist for a caller reporting several', () => {
    expect(SHIFTS_CHANGED_ERROR).toBe('These shifts have just changed. Refresh and try again.')
  })
})
