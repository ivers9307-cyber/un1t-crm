// Pure helpers for the ac-auto-off cron (C7 remainder).
//
// A vendor-failed auto-off used to sit in status='failed' and get re-picked
// by EVERY 5-minute tick forever, with a console.warn as the only signal —
// invisible retry-forever. Two fixes, both DB-migration-free:
//
//  1. Backoff — a failed row is only retried once its last update
//     (ac_sessions.updated_at, bumped by the mig 103 touch trigger on every
//     status/failure_reason write) is older than FAILED_RETRY_BACKOFF_MS.
//     Rows keep self-healing, just at a sane cadence.
//  2. Alert — each vendor failure raises a sendOpsAlert (org-routed email,
//     master-push fallback — same convention as the glofox-data-quality
//     cron). sendOpsAlert has no persistent dedup, so the alert rate is
//     gated BY the backoff: one alert at first failure, then at most one
//     per backoff window per row while the vendor stays down.

/** Retry a failed auto-off at most once per hour (also the max alert rate per row). */
export const FAILED_RETRY_BACKOFF_MS = 60 * 60_000

/**
 * ISO cutoff for picking failed rows: rows with updated_at older than this
 * are due a retry.
 */
export function failedRetryCutoffIso(nowMs = Date.now(), backoffMs = FAILED_RETRY_BACKOFF_MS) {
  return new Date(nowMs - backoffMs).toISOString()
}

/**
 * Shape the ops alert for one vendor auto-off failure. Pure — the route
 * passes the result straight to sendOpsAlert.
 *
 * @param {{ device: { id:string, label?:string|null },
 *           location: { id:string, name?:string|null, organization_id?:string|null },
 *           failureReason: string }} args
 */
export function buildAutoOffFailureAlert({ device, location, failureReason }) {
  const deviceLabel = device?.label || device?.id || 'unknown device'
  const locationName = location?.name || location?.id || 'unknown location'
  const reason = String(failureReason ?? 'unknown error').slice(0, 500)
  return {
    organizationId: location?.organization_id ?? null,
    locationId: location?.id ?? null,
    subject: `AC auto-off failing at ${locationName}`,
    htmlBody: `<p>The scheduled auto-off for AC device <strong>${deviceLabel}</strong> at <strong>${locationName}</strong> failed: ${reason}. The unit may still be running. The cron keeps retrying hourly until the vendor recovers; check the device/integration if this persists.</p>`,
    pushBody: `AC auto-off for ${deviceLabel} at ${locationName} failed: ${reason}`,
  }
}
