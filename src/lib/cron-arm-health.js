// HEARTBEAT.1 — heartbeat rows for the cron ARMS that ride another cron's
// schedule, and when an arm's run is clean enough to stamp its own row.
//
// WHY. An arm that shares a parent cron shares its heartbeat row, and that row
// is stamped whatever the arm did. /api/cron/health-check reads only
// cron_health.is_stale (mig 053), never last_outcome, so an arm that throws on
// every run pages nobody: its failure is a field in a response nobody keeps.
// SWAPHB.1 (mig 623) fixed that for the swap cover arm of checklist-sweep; this
// does the same for:
//
//   'shift-reminders' — runShiftReminders (src/lib/shift-reminders.js), the
//                       shift arm of the */5 send-push-reminders cron.
//   'roster-runway'   — runRosterRunwayAlerts (src/lib/roster-runway-notify.js),
//                       the first arm of the daily 08:00 UTC contract-reminders cron.
//   'shift-time-changes' — runShiftTimeChangeNotices (src/lib/block-edit-notify.js,
//                       BLOCKEDIT.1), the time-change notice arm of send-push-reminders.
//   'replace-notices' — runReplaceNotices (src/lib/shift-replace-notify.js,
//                       REPLACE.1a), the held replace-notice arm of the */5
//                       send-push-reminders cron.
//   'qualification-digest' — runQualificationDigest (src/lib/qualification-digest.js,
//                       QUALS.1), the third arm of the daily contract-reminders cron.
//
// Seeding (stampHeartbeat is UPDATE-only): 'shift-reminders' and
// 'roster-runway' by mig 633, 'shift-time-changes' by mig 639,
// 'replace-notices' by mig 640, 'qualification-digest' by mig 635. Each
// row's upsert is (re-)run RIGHT AFTER the deploy that stamps it: a row
// seeded before that code is live goes stale after interval + grace.
//
// REPLACE.1b adds a fifth:
//
//   'shift-offer-sweep' — runShiftOfferSweep (src/lib/shift-offer-server.js),
//                       the "Offer to team" arm of the */5 send-push-reminders
//                       cron. Seeded by mig 642, applied RIGHT AFTER the deploy.
//
// THE RULE. Stamp only when the arm RETURNED an outcome object (a throw, or a
// resolved non-object, has not shown it ran) and that outcome carries no
// fault in the arm's own machinery. A run with nothing to send is healthy (a
// quiet day, a quiet-hours tick, no locations): otherwise the shift row would
// go stale every night. A failed DELIVERY to one device is not an arm fault:
// both arms release that claim and retry it (next tick / next day), and the
// count rides in the row's last_outcome.

export const SHIFT_REMINDERS_HEARTBEAT = 'shift-reminders'
export const ROSTER_RUNWAY_HEARTBEAT = 'roster-runway'
// BLOCKEDIT.1 — the time-change notice arm (src/lib/block-edit-notify.js
// runShiftTimeChangeNotices) of the */5 send-push-reminders cron. Seeded by mig 639.
export const SHIFT_TIME_CHANGES_HEARTBEAT = 'shift-time-changes'
export const REPLACE_NOTICES_HEARTBEAT = 'replace-notices'
// REPLACE.1b — the shift-offer arm (src/lib/shift-offer-server.js
// runShiftOfferSweep) of the */5 send-push-reminders cron. Seeded by mig 642.
export const SHIFT_OFFER_SWEEP_HEARTBEAT = 'shift-offer-sweep'

// runShiftReminders' counters that mean the ARM went wrong, not a device:
//   shift_claim_failed — a ledger claim insert failed; that reminder was NOT sent.
//   shift_send_threw   — notifyUsers threw (documented never to); claim kept, reminder lost.
//   shift_read_capped  — the shift read hit the 1,000-row cap; reminders were missed.
// NOT here: shift_send_failed (nothing delivered, claim released, next tick retries).
export const SHIFT_ARM_FAULT_KEYS = Object.freeze(['shift_claim_failed', 'shift_send_threw', 'shift_read_capped'])

const isOutcome = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
const count = (v) => (Number.isFinite(v) ? v : 0)

/** True when a runShiftReminders() summary shows a clean run (see the header). */
export function shiftReminderArmHealthy(summary) {
  if (!isOutcome(summary)) return false
  return SHIFT_ARM_FAULT_KEYS.every((key) => count(summary[key]) === 0)
}

/**
 * True when a runRosterRunwayAlerts() outcome shows a clean run. The arm throws
 * on every failure of its own (a locations or runway read), which the parent
 * cron records as { error }; `failed` is a per-recipient delivery count whose
 * claims are released for the next daily run, so it does not block the stamp.
 */
export function runwayArmHealthy(outcome) {
  if (!isOutcome(outcome)) return false
  return !Object.prototype.hasOwnProperty.call(outcome, 'error')
}

// QUALS.1 — the weekly qualification digest arm of contract-reminders. Seeded by mig 635.
export const QUALIFICATION_DIGEST_HEARTBEAT = 'qualification-digest'

/**
 * True when a runQualificationDigest() outcome shows a clean run. The arm
 * throws on every failure of its own (a read, the week's stamps included),
 * which the cron records as { error }. NOT faults: `failed` (a delivery that
 * failed outright, not stamped, retried the next day) and `stamp_failed` (the
 * digest WAS delivered; a lost week stamp costs a duplicate the next day,
 * logged). A week with nothing due, and a quiet-hours run, are clean.
 */
export function qualificationDigestArmHealthy(outcome) {
  if (!isOutcome(outcome)) return false
  return !Object.prototype.hasOwnProperty.call(outcome, 'error')
}

// runShiftTimeChangeNotices' counters that mean the ARM went wrong, not a device:
//   time_change_read_failed  — the unsent-rows read failed; nobody was told this tick.
//   time_change_read_capped  — the read hit the 1,000-row page; the rest waited.
//   time_change_stamp_failed — a 'not_needed' stamp failed; that row is re-planned
//                              next tick, and meanwhile the drawer shows it unsent.
// NOT here: time_change_send_failed (claim released, next tick retries),
// time_change_deduped / _undelivered (left for the re-publish safety net) and
// time_change_told_stamp_failed (the coach WAS told; logged and counted).
export const TIME_CHANGE_ARM_FAULT_KEYS = Object.freeze(['time_change_read_failed', 'time_change_read_capped', 'time_change_stamp_failed'])

/** True when a runShiftTimeChangeNotices() summary shows a clean run (quiet ticks included). */
export function timeChangeArmHealthy(summary) {
  if (!isOutcome(summary)) return false
  return TIME_CHANGE_ARM_FAULT_KEYS.every((key) => count(summary[key]) === 0)
}

/**
 * REPLACE.1a — true when a runReplaceNotices() outcome shows a clean run.
 * Faults in the arm's own machinery, each retried next tick:
 *   errors       — the held-row read, or the silent (no-message) stamp, failed.
 *   stamp_failed — a notice was DELIVERED but its rows could not be stamped:
 *                  the coach is told again next tick, until the stamp lands.
 * A quiet-hours tick and a tick with nothing held are healthy. NOT a fault:
 * send_failed (nothing delivered, nothing stamped, next tick retries) and
 * undelivered (opted out / unreachable, left for the re-publish safety net).
 */
export function replaceNoticeArmHealthy(outcome) {
  if (!isOutcome(outcome)) return false
  return count(outcome.errors) === 0 && count(outcome.stamp_failed) === 0
}

/**
 * REPLACE.1b — true when a runShiftOfferSweep() outcome shows a clean run.
 * Faults in the arm's own machinery, each retried next tick:
 *   errors       — an offer list could not be read, a list filled its 200-row
 *                  guard (capped: the rest waited), or a lease / close /
 *                  give-up write failed.
 *   stamp_failed — a notice was DELIVERED but its stamp did not land: it is
 *                  sent again once the lease expires, until the stamp lands.
 * A quiet-hours tick, a tick with no offers and a busy lease are healthy. NOT
 * a fault: retry (the audience could not be read, or the send failed
 * outright: the lease is released and the next tick retries) and gave_up
 * (logged loudly on its own, and shown on the manager's line).
 */
export function offerSweepArmHealthy(outcome) {
  if (!isOutcome(outcome)) return false
  return count(outcome.errors) === 0 && count(outcome.stamp_failed) === 0
}
