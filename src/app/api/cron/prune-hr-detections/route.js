import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'
import {
  HR_DETECTIONS_RETENTION_DAYS,
  HR_DETECTIONS_PRUNE_BATCH,
  HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN,
  detectionsRetentionCutoff,
  isDetectionsCutoffSafe,
  wouldExceedDetectionsDeleteCap,
} from '@/lib/hr-detections-retention'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/prune-hr-detections
 *
 * H1c — hr_detections retention. Weekly off-peak Vercel cron that DELETES
 * ambient strap-detection rows (mig 292) not seen for 30 days:
 *   - hr_detection_visits with last_sample_at older than the cutoff
 *   - hr_detections with last_seen_at older than the cutoff
 *
 * These tables log every BLE strap the bridge sees — passers-by included —
 * with device names attached, so keeping them indefinitely is GDPR-adjacent.
 * Unlike prune-hr-samples (DECISION #3, a downsample), this is a hard delete:
 * detections are ambient observation, not a member's workout record. Linked
 * members' session data (heart_rate_sessions / hr_samples) is untouched.
 *
 * ORDER: visits first, then detections. hr_detection_visits cascades from
 * hr_detections (ON DELETE CASCADE), and a detection's last_seen_at is always
 * >= its visits' last_sample_at (both bump on the same sample path), so a
 * stale detection can never own a fresh visit — deleting the detection last
 * just cascades any visit rows the first phase's cap left behind. The
 * denormalised current_visit_id pointer (no FK) can't dangle either: a visit
 * old enough to prune belongs to a detection that is itself pruned this run
 * or a later one, and the pointer is only read on the recording hot path for
 * straps that are CURRENTLY present.
 *
 * SAFETY (never a single unbounded DELETE — mirrors prune-hr-samples):
 *   - Guarded: refuses to run if the computed cutoff isn't safely historic
 *     (isDetectionsCutoffSafe) — a clock/config error can't touch recent rows.
 *   - Bounded per run: ids are selected in batches of HR_DETECTIONS_PRUNE_BATCH
 *     and at most HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN rows are deleted per
 *     table; a months-old backlog drains over a few weekly ticks.
 *   - Guarded delete: every DELETE re-asserts the age filter (.lt on the age
 *     column) alongside the .in(id) list, so even a wrong id list can never
 *     touch a recently-seen row.
 *   - Idempotent: a re-run finds nothing older than the cutoff and deletes 0.
 *
 * Secured by CRON_SECRET (Vercel cron sends Authorization: Bearer <secret>).
 */

/**
 * Delete rows from `table` whose `ageColumn` is older than `cutoffIso`, in
 * bounded id-batches with the age filter re-asserted on every DELETE.
 * Returns { deleted, capReached, error }.
 */
async function pruneTable(db, table, ageColumn, cutoffIso) {
  let deleted = 0
  let capReached = false

  for (;;) {
    if (wouldExceedDetectionsDeleteCap(deleted, HR_DETECTIONS_PRUNE_BATCH, HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN)) {
      capReached = true
      break
    }

    // Oldest-first id batch. Selecting ids (not deleting by filter alone)
    // keeps each DELETE bounded and lets the cap stop the run cleanly.
    const { data: batch, error: selErr } = await db
      .from(table)
      .select('id')
      .lt(ageColumn, cutoffIso)
      .order(ageColumn, { ascending: true })
      .range(0, HR_DETECTIONS_PRUNE_BATCH - 1)
    if (selErr) return { deleted, capReached, error: `select: ${selErr.message}` }

    const ids = (batch || []).map((r) => r.id).filter(Boolean)
    if (ids.length === 0) break

    // Guarded delete — double-belt: the .lt(cutoffIso) re-assert means a stale
    // or wrong id list can NEVER delete a row that has been seen recently.
    const { error: delErr, count } = await db
      .from(table)
      .delete({ count: 'exact' })
      .lt(ageColumn, cutoffIso)
      .in('id', ids)
    if (delErr) return { deleted, capReached, error: `delete: ${delErr.message}` }

    deleted += count ?? 0
    // A short batch means the backlog is drained. Also bail if the delete
    // removed nothing (cascade already took the rows) to guarantee progress.
    if (ids.length < HR_DETECTIONS_PRUNE_BATCH || (count ?? 0) === 0) break
  }

  return { deleted, capReached, error: null }
}

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const cutoff = detectionsRetentionCutoff(now, HR_DETECTIONS_RETENTION_DAYS)

  // SAFETY GUARD: bail before any delete if the cutoff isn't clearly historic.
  if (!isDetectionsCutoffSafe(cutoff, now, HR_DETECTIONS_RETENTION_DAYS)) {
    logError('cron.prune-hr-detections', 'unsafe retention cutoff — aborting', {
      cutoff: cutoff.toISOString(),
      now: now.toISOString(),
    })
    return NextResponse.json(
      { success: false, error: 'unsafe_cutoff', cutoff: cutoff.toISOString() },
      { status: 500 },
    )
  }

  const cutoffIso = cutoff.toISOString()
  const db = createServerClient()

  // Phase 1 — stale visits (last activity in the visit older than the cutoff).
  const visits = await pruneTable(db, 'hr_detection_visits', 'last_sample_at', cutoffIso)
  if (visits.error) {
    logError('cron.prune-hr-detections', 'visit prune failed', { err: visits.error })
    return NextResponse.json({ success: false, error: visits.error }, { status: 500 })
  }

  // Phase 2 — stale detections (strap not seen at all since the cutoff).
  // Cascades any remaining old visit rows via the mig 292 FK.
  const detections = await pruneTable(db, 'hr_detections', 'last_seen_at', cutoffIso)
  if (detections.error) {
    logError('cron.prune-hr-detections', 'detection prune failed', { err: detections.error })
    return NextResponse.json({ success: false, error: detections.error }, { status: 500 })
  }

  const outcome = {
    cutoff: cutoffIso,
    retention_days: HR_DETECTIONS_RETENTION_DAYS,
    visits_deleted: visits.deleted,
    detections_deleted: detections.deleted,
    cap_reached: visits.capReached || detections.capReached,
  }
  logInfo('cron.prune-hr-detections', 'run complete', outcome)

  await stampHeartbeat('prune-hr-detections', outcome)
  return NextResponse.json({ success: true, data: outcome })
}
