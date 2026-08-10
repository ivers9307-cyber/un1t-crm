// Activity event-writers — small helpers that drop kind='event'
// rows on a contact's timeline when something noteworthy happens.
//
// Activities revamp phase 1 (mig 073). The pattern: every event
// writer is async, best-effort, and swallows its own errors so a
// timeline-logging miss can't fail the upstream mutation. The
// caller doesn't await — the response can ship while the
// activity row gets written in the background.
//
// DEAD-DOCSTRING.1 — `logPipelineEvent` used to live here. It was the
// phase-1 demo writer, and its docstring said it was "called from
// PUT /api/contacts/[id] alongside the existing
// triggerSequencesForPipelineStageChange path". It was not: nothing in
// the repo (src, mobile, shared, scripts) ever imported it outside its
// own test file. Deleted rather than wired up, because the lie was the
// harm — a reader auditing the timeline saw a stage-change writer that
// looked live and concluded pipeline moves were being logged, when no
// row was ever written by it. Restoring it means restoring the CALL first
// (see docs/CHANGELOG.md #76 for the phase-1 evaluation it belonged to).
//
// logPipelineDismissal below IS live (operator Cold dismissal/restore).

import { logWarn } from '@/lib/log'

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
