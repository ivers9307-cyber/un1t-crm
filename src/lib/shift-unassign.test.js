// LEAVE.1 — unassignShiftAssignments is the delete + change-log + NOTIFY.1
// path shared by DELETE /api/schedule/assignments/[id] and the leave-clash
// "Unassign them" action.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/roster-change-notify', () => ({ notifyRosterChanges: vi.fn(async () => ({ notified: 1 })) }))

const { logRosterChange } = await import('@/lib/roster-change-log')
const { notifyRosterChanges } = await import('@/lib/roster-change-notify')
const { unassignShiftAssignments } = await import('./shift-unassign.js')
const { fakeDb, queriesOf } = await import('./time-off.test-helpers.js')

const a = (id, location_id, roster_status = 'published', block_date = '2026-06-01') =>
  ({ id, profile_id: 'coach', block_id: `b-${id}`, block_date, location_id, roster_status })

beforeEach(() => vi.clearAllMocks())

describe('unassignShiftAssignments', () => {
  it('deletes each row, logs published ones, and notifies once per studio', async () => {
    const db = fakeDb(() => ({ data: null, error: null }))
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
    const db = fakeDb((q) => (q.eq.id === '1' ? { error: { message: 'locked' } } : { error: null }))
    const out = await unassignShiftAssignments(db, { actorId: 'mgr', assignments: [a('1', 'loc-1'), a('2', 'loc-1')] })
    expect(out.failed).toEqual([{ id: '1', error: 'locked' }])
    expect(out.removed.map((r) => r.id)).toEqual(['2'])
    expect(logRosterChange).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges.mock.calls[0][1].changes.map((c) => c.blockId)).toEqual(['b-2'])
  })
})
