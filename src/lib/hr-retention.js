// src/lib/hr-retention.js
//
// DECISION #3 — hr_samples retention: keep raw for 12 months, then DOWNSAMPLE.
//
// hr_samples is the highest-cardinality table in the schema: ~1 row/sec per
// active strap per session (mig 110 note: "~3600 rows/hour/session"). The
// per-session SUMMARY (zones_seconds, effort_points, avg/peak bpm, calories)
// already lives on heart_rate_sessions and is KEPT FOREVER — only the raw
// high-frequency trace is reduced here.
//
// We DOWNSAMPLE rather than hard-delete: after 12 months we keep ONE
// representative sample per session per 30-second bucket and delete the
// intra-bucket rest. This preserves the shape of the HR trace for old reports
// / share links while cutting row volume ~30× (1 Hz → 1 per 30 s).
//
// Why 30 s buckets: the customer-facing session report / TV replay renders the
// trace as a sparkline over a ~45-min class; at that width sub-30s detail is
// visually indistinguishable, and zone-time is a KEPT summary field so we don't
// depend on raw granularity to recompute it. 30 s is coarse enough for a big
// win but fine enough that peaks/dips in an interval class still register. It
// aligns with our zone maths (whole seconds) and is a round divisor of a minute.
//
// This module is PURE (no DB, no clock): the route feeds it rows + a cutoff and
// it decides which sample rows to keep vs delete. That makes the age-cutoff,
// bucket-selection, and batch-cap logic unit-testable without a database, and
// keeps the destructive SQL in the route thin and auditable.

// Retention window: raw samples stay untouched for this long. After it, older
// samples are downsampled (NOT deleted outright — the trace shape is kept).
export const HR_RAW_RETENTION_MONTHS = 12

// Downsample bucket width. One sample survives per session per bucket.
export const HR_DOWNSAMPLE_BUCKET_SECONDS = 30
const BUCKET_MS = HR_DOWNSAMPLE_BUCKET_SECONDS * 1000

// Safety caps for a single cron run — bound the blast radius so one tick can
// never issue an unbounded delete. Tuned for a weekly off-peak run; the backlog
// drains over a few runs on first deployment (see route "first-run safety").
export const HR_PRUNE_MAX_SESSIONS_PER_RUN = 200
export const HR_PRUNE_MAX_DELETES_PER_RUN = 50_000

/**
 * Compute the age cutoff: samples with recorded_at STRICTLY OLDER than this are
 * eligible for downsampling. Pure — the caller passes "now" so tests are
 * deterministic and we never touch recent data by accident.
 *
 * @param {Date|string|number} now
 * @param {number} [months=HR_RAW_RETENTION_MONTHS]
 * @returns {Date}
 */
export function retentionCutoff(now = new Date(), months = HR_RAW_RETENTION_MONTHS) {
  const d = new Date(now)
  if (Number.isNaN(d.getTime())) throw new Error('retentionCutoff: invalid now')
  if (!Number.isInteger(months) || months <= 0) {
    throw new Error('retentionCutoff: months must be a positive integer')
  }
  const out = new Date(d)
  out.setUTCMonth(out.getUTCMonth() - months)
  return out
}

/**
 * SAFETY GUARD — refuse a cutoff that isn't safely in the past.
 *
 * A misconfigured window (months=0, a future clock, a bad env) could otherwise
 * hand us a cutoff at/after "now" and downsample RECENT data. We require the
 * cutoff to be at least (months - 1) months before now, i.e. clearly historic.
 * Returns true when the cutoff is safe to act on.
 *
 * @param {Date} cutoff
 * @param {Date|string|number} now
 * @param {number} [months=HR_RAW_RETENTION_MONTHS]
 */
export function isCutoffSafe(cutoff, now = new Date(), months = HR_RAW_RETENTION_MONTHS) {
  const c = new Date(cutoff)
  const n = new Date(now)
  if (Number.isNaN(c.getTime()) || Number.isNaN(n.getTime())) return false
  // Minimum age the cutoff must clear: months - 1 (guards off-by-one on the
  // month-length boundary) but never less than 11 months for the default window.
  const minMonthsBack = Math.max(months - 1, 0)
  const floor = new Date(n)
  floor.setUTCMonth(floor.getUTCMonth() - minMonthsBack)
  return c.getTime() <= floor.getTime()
}

/**
 * Bucket key for a timestamp — floor(recorded_at / 30s). Two samples share a
 * bucket iff they fall in the same 30-second window (UTC-anchored, so it's
 * stable regardless of server TZ).
 *
 * @param {Date|string|number} recordedAt
 * @returns {number} epoch-ms of the bucket start
 */
export function bucketKey(recordedAt) {
  const t = new Date(recordedAt).getTime()
  if (Number.isNaN(t)) throw new Error('bucketKey: invalid recordedAt')
  return Math.floor(t / BUCKET_MS) * BUCKET_MS
}

/**
 * DOWNSAMPLE DECISION (pure) for a single session's old samples.
 *
 * Given the samples (each { recorded_at }) that are already known to be older
 * than the cutoff, decide which to KEEP (one representative per 30s bucket, the
 * earliest recorded_at in the bucket) and which to DELETE (all the rest).
 *
 * Deterministic: we keep the earliest sample per bucket so repeated runs are
 * idempotent — after one pass each bucket has exactly one sample, and a second
 * pass finds nothing to delete.
 *
 * @param {Array<{recorded_at: string|Date|number}>} samples
 * @returns {{ keep: string[], delete: string[] }} ISO strings of recorded_at
 */
export function planSessionDownsample(samples) {
  // Winning (earliest) timestamp per bucket.
  const winnerByBucket = new Map() // bucketKey -> t
  const rows = []
  for (const s of samples || []) {
    const t = new Date(s.recorded_at).getTime()
    if (Number.isNaN(t)) continue // skip unparseable; never delete what we can't reason about
    const bucket = Math.floor(t / BUCKET_MS) * BUCKET_MS
    rows.push({ iso: new Date(t).toISOString(), t, bucket })
    const cur = winnerByBucket.get(bucket)
    if (cur === undefined || t < cur) winnerByBucket.set(bucket, t)
  }

  const keep = []
  const del = []
  // A bucket's winner is kept exactly once (the first row whose timestamp
  // equals the bucket winner). Everything else — later rows AND any exact
  // duplicate of the winning timestamp — is deleted. recorded_at is part of
  // the PK (session_id, recorded_at) so exact dupes shouldn't occur, but
  // handling them keeps this robust and idempotent.
  const keptBucket = new Set()
  for (const r of rows) {
    if (r.t === winnerByBucket.get(r.bucket) && !keptBucket.has(r.bucket)) {
      keptBucket.add(r.bucket)
      keep.push(r.iso)
    } else {
      del.push(r.iso)
    }
  }
  return { keep, delete: del }
}

/**
 * Would this session's downsample push the run over its per-run delete cap?
 * The route uses this to stop cleanly mid-backlog without exceeding
 * HR_PRUNE_MAX_DELETES_PER_RUN, leaving the remainder for the next tick.
 *
 * @param {number} deletesSoFar
 * @param {number} sessionDeletes
 * @param {number} [cap=HR_PRUNE_MAX_DELETES_PER_RUN]
 */
export function wouldExceedDeleteCap(deletesSoFar, sessionDeletes, cap = HR_PRUNE_MAX_DELETES_PER_RUN) {
  return deletesSoFar + sessionDeletes > cap
}
