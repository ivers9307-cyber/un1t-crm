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

  await logAndNotifyUnassignments(db, { actorId, assignments: removed })

  return { removed, failed }
}

/**
 * SLOTNOTIFY.1 — the audit + notification half of an unassignment, for callers
 * whose DELETE is not one row at a time.
 *
 * Split out of unassignShiftAssignments so DELETE /api/schedule/blocks/[id] can
 * reuse it verbatim: deleting a staffed slot takes the assignments with it
 * through the FK cascade (mig 067), so there is no per-row delete to hang the
 * log and the notification off, and both were simply missing — the coaches lost
 * a published shift and nobody told them, with no change-log row for the
 * re-publish safety net to find either.
 *
 * Every rule stays where it was: only a PUBLISHED roster's removals are logged
 * (a draft edit rides the first-publish notice, and logRosterChange no-ops on
 * it anyway) and notifyRosterChanges owns the rest — grouping a coach's
 * removals into one message, skipping the actor and anything already in the
 * past, and stamping notified_at only on the rows it could deliver, leaving an
 * opted-out coach's rows for the re-publish safety net.
 *
 * Best-effort, like every notification path here: never throws, never blocks
 * the delete that already succeeded.
 *
 * @param {object} db   service-role client
 * @param {object} args
 * @param {string} args.actorId
 * @param {Array<{ profile_id: string, block_id: string, block_date: string,
 *   location_id: string, roster_status?: string|null }>} args.assignments
 *   assignments that are ALREADY gone from the database.
 */
export async function logAndNotifyUnassignments(db, { actorId, assignments }) {
  const published = (assignments || []).filter((a) => a.roster_status === 'published')
  if (published.length === 0) return { logged: 0, notified: 0 }

  for (const a of published) {
    await logRosterChange(db, {
      isPublished: true,
      locationId: a.location_id,
      blockId: a.block_id,
      blockDate: a.block_date,
      actorId,
      coachId: a.profile_id,
      action: 'unassigned',
      ...(a.details ? { details: a.details } : {}),
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
  let notified = 0
  for (const [locationId, changes] of byLocation) {
    const res = await notifyRosterChanges(db, { locationId, actorId, changes })
    notified += res?.notified || 0
  }

  return { logged: published.length, notified }
}
