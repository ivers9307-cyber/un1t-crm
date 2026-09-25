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
//
// Both rows are seeded by mig 633 (stampHeartbeat is UPDATE-only).
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
