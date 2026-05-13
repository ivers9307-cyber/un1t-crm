// Activity event-writers — small helpers that drop kind='event'
// rows on a contact's timeline when something noteworthy happens.
//
// Activities revamp phase 1 (mig 073). The pattern: every event
// writer is async, best-effort, and swallows its own errors so a
// timeline-logging miss can't fail the upstream mutation. The
// caller doesn't await — the response can ship while the
// activity row gets written in the background.
//
// Phase 1 demonstrates the pattern with logPipelineEvent. Phase 2
// will add deposit-paid, sequence-enrolled, swap-approved,
// roster-published-to-coach (once we figure out the staff-vs-
// contact wiring for that one).

import { logWarn } from '@/lib/log'

const STATUS_LABELS = {
  active_trial: 'Active Trial',
  cold: 'Cold',
  lost_member: 'Lost Member',
  member: 'Member',
  returning: 'Returning',
}

function humanise(status) {
  return STATUS_LABELS[status] || status
}

/**
 * Log a "pipeline stage changed" event to the contact timeline.
 * Called from PUT /api/contacts/[id] alongside the existing
 * triggerSequencesForPipelineStageChange path.
 *
 * @param {SupabaseClient} db   service-role client
 * @param {object} args
 * @param {string} args.contactId
 * @param {string} args.locationId
 * @param {string} args.oldStatus
 * @param {string} args.newStatus
 * @param {string} [args.userId] — who flipped the stage; goes
 *                                 into the note for audit context.
 */
export async function logPipelineEvent(db, { contactId, locationId, oldStatus, newStatus, userId }) {
  if (!contactId || !locationId) return
  if (oldStatus === newStatus) return

  const subject = `Stage: ${humanise(oldStatus)} → ${humanise(newStatus)}`
  const note = userId ? `Updated by ${userId}` : null

  try {
    await db.from('activities').insert({
      contact_id: contactId,
      location_id: locationId,
      kind: 'event',
      type: 'pipeline',
      subject,
      note,
      done: false,
    })
  } catch (e) {
    logWarn('activity-events', 'logPipelineEvent failed', { contactId, err: e })
  }
}
