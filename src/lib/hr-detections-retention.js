// src/lib/hr-detections-retention.js
//
// H1c — hr_detections / hr_detection_visits retention: 30 days, then DELETE.
//
// The detections registry (mig 292) records EVERY HR strap the bridge sees at a
// location — including passers-by who never linked a strap to a member. Rows
// carry BLE device names (last_name) and appearance history, which makes an
// indefinite log GDPR-adjacent: there is no operational reason to know which
// unlinked strap walked past the studio months ago. The coach "Detected" tab
// only needs recent activity (its useful horizon is "who is in the room /
// was here lately"), so anything not seen for 30 days is deleted outright.
//
// Unlike hr_samples (DECISION #3 — downsample, keep the trace shape), this IS
// an erasure: detections are ambient observation, not a member's workout
// record. Linked members' actual session data lives on heart_rate_sessions /
// hr_samples and is untouched by this module.
//
// This module is PURE (no DB, no clock) — mirrors src/lib/hr-retention.js: the
// route feeds it "now" and it hands back the cutoff + safety verdict, keeping
// the destructive SQL in the route thin and auditable.

// Retention window: a detection (keyed on last_seen_at) or a visit (keyed on
// last_sample_at) older than this is deleted by the weekly prune cron.
export const HR_DETECTIONS_RETENTION_DAYS = 30

// Safety caps for a single cron run — bound the blast radius so one tick can
// never issue an unbounded delete. Per-table cap; the first run drains a
// months-old backlog over a few weekly ticks.
export const HR_DETECTIONS_PRUNE_BATCH = 500
export const HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN = 5000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Compute the age cutoff: rows whose age column is STRICTLY OLDER than this
 * are eligible for deletion. Pure — the caller passes "now" so tests are
 * deterministic and we never touch recent data by accident.
 *
 * @param {Date|string|number} now
 * @param {number} [days=HR_DETECTIONS_RETENTION_DAYS]
 * @returns {Date}
 */
export function detectionsRetentionCutoff(now = new Date(), days = HR_DETECTIONS_RETENTION_DAYS) {
  const d = new Date(now)
  if (Number.isNaN(d.getTime())) throw new Error('detectionsRetentionCutoff: invalid now')
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error('detectionsRetentionCutoff: days must be a positive integer')
  }
  return new Date(d.getTime() - days * DAY_MS)
}

/**
 * SAFETY GUARD — refuse a cutoff that isn't safely in the past (mirrors
 * isCutoffSafe in hr-retention.js). A misconfigured window (days=0, a future
 * clock) could otherwise hand us a cutoff at/after "now" and delete straps
 * seen TODAY. We require the cutoff to be at least (days - 1) days before
 * now, i.e. clearly historic. Returns true when the cutoff is safe to act on.
 *
 * @param {Date} cutoff
 * @param {Date|string|number} now
 * @param {number} [days=HR_DETECTIONS_RETENTION_DAYS]
 */
export function isDetectionsCutoffSafe(cutoff, now = new Date(), days = HR_DETECTIONS_RETENTION_DAYS) {
  const c = new Date(cutoff)
  const n = new Date(now)
  if (Number.isNaN(c.getTime()) || Number.isNaN(n.getTime())) return false
  const minDaysBack = Math.max(days - 1, 0)
  return c.getTime() <= n.getTime() - minDaysBack * DAY_MS
}

/**
 * Would this batch push the run over its per-table delete cap? The route uses
 * this to stop cleanly mid-backlog, leaving the remainder for the next tick.
 *
 * @param {number} deletesSoFar
 * @param {number} batchSize
 * @param {number} [cap=HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN]
 */
export function wouldExceedDetectionsDeleteCap(deletesSoFar, batchSize, cap = HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN) {
  return deletesSoFar + batchSize > cap
}
