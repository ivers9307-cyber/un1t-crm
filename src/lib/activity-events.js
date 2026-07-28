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

// FUNNEL.1 taxonomy. Historical timeline rows may carry retired slugs
// (active_trial et al) — humanise() falls back to title-casing them.
const STATUS_LABELS = {
  new_lead: 'New Lead',
  first_class: '1st Class Completed',
  second_class: '2nd Class Completed',
  trial_done: 'Trial Done',
  converted: 'Converted',
  member: 'Member',
  pack_member: 'Class Pack',
  classpass: 'ClassPass',
  gympass: 'Gympass',
  cold_lead: 'Cold',
  dormant: 'Dormant',
}

function humanise(status) {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status]
  return String(status).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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

/**
 * Log an operator Cold dismissal (or restore) with actor attribution.
 *
 * The deals trigger (mig 003/004) writes an unattributed
 * "Pipeline: moved to Cold" row when the deal moves stage — it runs
 * as service role and has no idea WHO clicked. This row is the
 * operator-action record: it carries the acting staff member's name
 * and fires even when the deal doesn't move (already cold, classifier
 * disagreement), because the dismissal itself still happened.
 *
 * @param {SupabaseClient} db   service-role client
 * @param {object} args
 * @param {string}  args.contactId
 * @param {string}  args.locationId
 * @param {boolean} args.cold        true = dismissed, false = restored
 * @param {string}  [args.actorName] acting user's display name (falls
 *                                   back to email upstream; 'Unknown
 *                                   staff' here as a last resort)
 */
export async function logPipelineDismissal(db, { contactId, locationId, cold, actorName }) {
  if (!contactId || !locationId) return

  const who = (actorName && String(actorName).trim()) || 'Unknown staff'
  const subject = cold ? `Moved to Cold by ${who}` : `Returned to pipeline by ${who}`
  const note = cold
    ? 'Operator dismissal: lead taken off the pipeline.'
    : 'Operator restore: lead returned to the pipeline.'

  try {
    await db.from('activities').insert({
      contact_id: contactId,
      location_id: locationId,
      kind: 'event',
      type: 'pipeline',
      subject,
      note,
      done: true,
    })
  } catch (e) {
    logWarn('activity-events', 'logPipelineDismissal failed', { contactId, err: e })
  }
}
