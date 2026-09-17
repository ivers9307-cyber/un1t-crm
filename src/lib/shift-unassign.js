// LEAVE.2 — take coaches off shifts, the one way the roster does it.
//
// Extracted from DELETE /api/schedule/assignments/[id] so the "Unassign them"
// follow-up after approving leave goes through the SAME steps as a manager
// removing a coach by hand: delete the assignment, write the
// SCHEDULE-CHANGE-LOG.1 row when the roster is published (the re-publish
// safety net reads it), and tell the coach now (NOTIFY.1). notifyRosterChanges
// groups by coach, so a week of leave is one "removed from 4 shifts" message,
// not four.
//
// Authorisation is the CALLER's job: every assignment passed in must already
// have cleared the manager-at-the-shift's-studio gate.

import { logRosterChange } from '@/lib/roster-change-log'
import { notifyRosterChanges } from '@/lib/roster-change-notify'

/**
 * @param {object} db   service-role client
 * @param {object} args
 * @param {string} args.actorId
 * @param {Array<{ id: string, profile_id: string, block_id: string,
 *   block_date: string, location_id: string, roster_status?: string|null }>} args.assignments
 * @returns {Promise<{ removed: object[], failed: Array<{ id: string, error: string }> }>}
 */
export async function unassignShiftAssignments(db, { actorId, assignments }) {
  const removed = []
  const failed = []

  // One DELETE per row, each judged on its own: a failure on one shift must
  // not be reported as the whole set failing, nor hide the ones that went.
  for (const a of assignments || []) {
    const { error } = await db.from('shift_assignments').delete().eq('id', a.id)
    if (error) {
      failed.push({ id: a.id, error: error.message || 'delete_failed' })
      continue
    }
    removed.push(a)
  }

  const published = removed.filter((a) => a.roster_status === 'published')
  for (const a of published) {
    await logRosterChange(db, {
      isPublished: true,
      locationId: a.location_id,
      blockId: a.block_id,
      blockDate: a.block_date,
      actorId,
      coachId: a.profile_id,
      action: 'unassigned',
    })
  }

  // notifyRosterChanges is per location (the change-log stamp is keyed on it).
  const byLocation = new Map()
  for (const a of published) {
    if (!byLocation.has(a.location_id)) byLocation.set(a.location_id, [])
    byLocation.get(a.location_id).push({
      coachId: a.profile_id,
      blockId: a.block_id,
      blockDate: a.block_date,
      action: 'unassigned',
    })
  }
  for (const [locationId, changes] of byLocation) {
    await notifyRosterChanges(db, { locationId, actorId, changes })
  }

  return { removed, failed }
}
