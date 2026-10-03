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

/**
 * Retry a failed auto-off at most once per hour — the fallback cadence for
 * failures that are NOT transient (creds wiped, device gone), and for a
 * transient one once FAST_RETRY_MAX_ATTEMPTS is spent.
 */
export const FAILED_RETRY_BACKOFF_MS = 60 * 60_000

// AC-RETRY.1 — a transient vendor failure is retried at the NEXT tick.
//
// Sensibo's own command history (3 Oct 2026) showed what our 12s timeouts
// really were: the request reached Sensibo every time; the POD did not
// acknowledge the OFF within Sensibo's window (status Failed / failureReason
// Timeout). ONs never failed, and an ON 98s after a failed OFF succeeded —
// the pod recovers in minutes. An hourly backoff left the unit running for
// up to an hour and emailed an operator on every single miss. So:
//   * a timeout-class failure is re-picked once it is FAST_RETRY_BACKOFF_MS
//     old — 4 min, i.e. the very next 5-minute tick (the cron lands ~30s
//     late, so 5 min would skip a tick) — for up to FAST_RETRY_MAX_ATTEMPTS
//     (an hour of tries), then hourly as before;
//   * the alert waits for ALERT_AFTER_ATTEMPTS consecutive misses (~15 min
//     overdue) and repeats at most every ALERT_REPEAT_MS while it keeps
//     failing. A NON-transient failure still alerts on the first miss —
//     nothing about it will clear on its own.
// One row per tick is still one vendor call: the limiter spaces calls and
// the cron stagger keeps the three AC crons apart, so this adds no burst.
/** A transient failure is re-picked once its last write is this old. */
export const FAST_RETRY_BACKOFF_MS = 4 * 60_000
/** Fast retries per row before dropping back to the hourly backoff. */
export const FAST_RETRY_MAX_ATTEMPTS = 12
/** Consecutive transient misses before the first ops alert. */
export const ALERT_AFTER_ATTEMPTS = 3
/** Minimum gap between two alerts for the same row. */
export const ALERT_REPEAT_MS = 60 * 60_000

/**
 * Is this failure_reason the kind that clears on its own — a timeout, an
 * abort, a network blip, a rate-limit push-back? Anything else (missing
 * creds, unknown device, vendor 4xx) is treated as persistent.
 */
export function isTransientVendorFailure(reason) {
  const text = String(reason ?? '')
  return /timeout|timed out|aborted|network error|rate limit|api limit|\b429\b|econn|fetch failed/i.test(text)
}

function parseMs(iso) {
  const ms = iso == null ? NaN : Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Should a `failed` row be retried on THIS tick? Pure.
 *
 *   - last write ≥ FAILED_RETRY_BACKOFF_MS ago → yes (the hourly fallback)
 *   - transient reason AND attempts < FAST_RETRY_MAX_ATTEMPTS AND last write
 *     ≥ FAST_RETRY_BACKOFF_MS ago → yes (the fast lane)
 *   - otherwise → no, leave it for a later tick
 * An unreadable updated_at counts as due: a row we cannot date must not
 * sit in `failed` forever.
 */
export function shouldRetryFailedRow(row, nowMs = Date.now()) {
  const writtenMs = parseMs(row?.updated_at)
  if (writtenMs == null) return true
  const age = nowMs - writtenMs
  if (age >= FAILED_RETRY_BACKOFF_MS) return true
  const attempts = Number(row?.auto_off_attempts) || 0
  return isTransientVendorFailure(row?.failure_reason)
    && attempts < FAST_RETRY_MAX_ATTEMPTS
    && age >= FAST_RETRY_BACKOFF_MS
}

/**
 * Should THIS failure raise an ops alert? Pure. `attempts` is the count
 * INCLUDING the failure that just happened.
 *
 *   transient → only from the ALERT_AFTER_ATTEMPTS-th consecutive miss
 *   persistent → from the first miss
 * and in both cases not within ALERT_REPEAT_MS of the previous alert. An
 * unreadable alertedAt counts as "never alerted".
 */
export function shouldAlertFailure({ transient, attempts, alertedAt, nowMs = Date.now() }) {
  const threshold = transient ? ALERT_AFTER_ATTEMPTS : 1
  if ((Number(attempts) || 0) < threshold) return false
  const lastMs = parseMs(alertedAt)
  if (lastMs == null) return true
  return nowMs - lastMs >= ALERT_REPEAT_MS
}

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
export function buildAutoOffFailureAlert({ device, location, failureReason, attempts = null, transient = false }) {
  const deviceLabel = device?.label || device?.id || 'unknown device'
  const locationName = location?.name || location?.id || 'unknown location'
  const reason = String(failureReason ?? 'unknown error').slice(0, 500)
  const n = Number(attempts) || 0
  const attemptsText = n > 1 ? ` (${n} attempts so far)` : ''
  const cadence = transient
    ? 'The cron retries every 5 minutes for the first hour, then hourly.'
    : 'The cron keeps retrying hourly until the vendor recovers.'
  return {
    organizationId: location?.organization_id ?? null,
    locationId: location?.id ?? null,
    subject: `AC auto-off failing at ${locationName}`,
    htmlBody: `<p>The scheduled auto-off for AC device <strong>${deviceLabel}</strong> at <strong>${locationName}</strong> failed${attemptsText}: ${reason}. The unit may still be running. ${cadence} Check the device/integration if this persists.</p>`,
    pushBody: `AC auto-off for ${deviceLabel} at ${locationName} failed${attemptsText}: ${reason}`,
  }
}
