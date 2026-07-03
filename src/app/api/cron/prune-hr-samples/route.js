import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'
import {
  HR_RAW_RETENTION_MONTHS,
  HR_DOWNSAMPLE_BUCKET_SECONDS,
  HR_PRUNE_MAX_SESSIONS_PER_RUN,
  HR_PRUNE_MAX_DELETES_PER_RUN,
  retentionCutoff,
  isCutoffSafe,
  planSessionDownsample,
  wouldExceedDeleteCap,
} from '@/lib/hr-retention'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/prune-hr-samples
 *
 * DECISION #3 — hr_samples retention. Weekly off-peak Vercel cron that
 * DOWNSAMPLES raw HR samples older than 12 months: it keeps one representative
 * sample per session per 30-second bucket and deletes the intra-bucket rest
 * (~30× volume reduction while preserving the trace shape). The per-session
 * SUMMARY on heart_rate_sessions is untouched and kept forever.
 *
 * Pure decision logic (cutoff, bucket selection, batch cap) lives in
 * @/lib/hr-retention and is unit-tested without a DB. This route is the thin,
 * bounded, idempotent IO shell.
 *
 * SAFETY (never a single unbounded DELETE):
 *   - Only ever touches recorded_at < now - 12 months, per session.
 *   - Guarded: refuses to run if the computed cutoff isn't safely historic
 *     (isCutoffSafe) — a clock/config error can't touch recent data.
 *   - Bounded per run: at most HR_PRUNE_MAX_SESSIONS_PER_RUN sessions and
 *     HR_PRUNE_MAX_DELETES_PER_RUN row deletes; the backlog drains over
 *     multiple weekly ticks.
 *   - Idempotent: after a session is downsampled, a re-run finds one sample
 *     per bucket and deletes nothing.
 *
 * Secured by CRON_SECRET (Vercel cron sends Authorization: Bearer <secret>).
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const cutoff = retentionCutoff(now, HR_RAW_RETENTION_MONTHS)

  // SAFETY GUARD: bail before any delete if the cutoff isn't clearly historic.
  if (!isCutoffSafe(cutoff, now, HR_RAW_RETENTION_MONTHS)) {
    logError('cron.prune-hr-samples', 'unsafe retention cutoff — aborting', {
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

  // Candidate sessions = those that STARTED before the cutoff. We anchor on
  // heart_rate_sessions.started_at (one row per workout — low cardinality)
  // rather than scanning the high-volume hr_samples table for distinct
  // session_ids. A session started > 12 months ago is exactly the set whose
  // raw samples are all past the retention window. Index-backed by
  // idx_hr_sessions_started_at (mig 353). Ordered + capped at MAX_SESSIONS so
  // the per-run set is bounded and the well-known 1k-row select cap can't
  // silently truncate us (we never fetch more than the cap in one go).
  const { data: candidateSessions, error: candErr } = await db
    .from('heart_rate_sessions')
    .select('id')
    .lt('started_at', cutoffIso)
    .order('started_at', { ascending: true })
    .range(0, HR_PRUNE_MAX_SESSIONS_PER_RUN - 1)

  if (candErr) {
    logError('cron.prune-hr-samples', 'candidate scan failed', { err: candErr.message })
    return NextResponse.json({ success: false, error: candErr.message }, { status: 500 })
  }

  const sessionIds = (candidateSessions || []).map(s => s.id).filter(Boolean)

  let sessionsProcessed = 0
  let sessionsDownsampled = 0
  let totalDeleted = 0
  let capReached = false

  for (const sessionId of sessionIds) {
    if (capReached) break

    // Fetch this session's OLD samples only (recorded_at is part of the PK, so
    // this is a tight index range scan). Bounded by the 1k-row select cap +
    // pagination; a single session over 12 months of a class is < a few
    // thousand rows, so we page defensively.
    const oldSamples = []
    let from = 0
    const PAGE = 1000
    let pageErr = null
    for (;;) {
      const { data: page, error } = await db
        .from('hr_samples')
        .select('recorded_at')
        .eq('session_id', sessionId)
        .lt('recorded_at', cutoffIso)
        .order('recorded_at', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) { pageErr = error; break }
      if (!page || page.length === 0) break
      for (const p of page) oldSamples.push(p)
      if (page.length < PAGE) break
      from += PAGE
    }
    if (pageErr) {
      logError('cron.prune-hr-samples', 'session sample fetch failed', {
        sessionId, err: pageErr.message,
      })
      continue // skip this session, try the rest
    }

    sessionsProcessed += 1
    const { delete: toDelete } = planSessionDownsample(oldSamples)
    if (toDelete.length === 0) continue

    // Respect the per-run delete cap — stop cleanly and leave the rest for the
    // next weekly tick rather than blowing the blast radius.
    if (wouldExceedDeleteCap(totalDeleted, toDelete.length, HR_PRUNE_MAX_DELETES_PER_RUN)) {
      capReached = true
      break
    }

    // Delete the losers by exact recorded_at within this session. Double-belt:
    // the .lt(cutoffIso) filter guarantees we can NEVER touch recent samples
    // even if the plan list were somehow wrong. Chunk the .in() list to keep
    // each request small.
    let sessionDeleted = 0
    const CHUNK = 500
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const chunk = toDelete.slice(i, i + CHUNK)
      const { error, count } = await db
        .from('hr_samples')
        .delete({ count: 'exact' })
        .eq('session_id', sessionId)
        .lt('recorded_at', cutoffIso)
        .in('recorded_at', chunk)
      if (error) {
        logError('cron.prune-hr-samples', 'delete chunk failed', {
          sessionId, err: error.message,
        })
        break // move on; partial progress is fine + idempotent
      }
      sessionDeleted += count ?? 0
    }
    if (sessionDeleted > 0) {
      totalDeleted += sessionDeleted
      sessionsDownsampled += 1
    }
  }

  const outcome = {
    cutoff: cutoffIso,
    retention_months: HR_RAW_RETENTION_MONTHS,
    bucket_seconds: HR_DOWNSAMPLE_BUCKET_SECONDS,
    candidate_sessions: sessionIds.length,
    sessions_processed: sessionsProcessed,
    sessions_downsampled: sessionsDownsampled,
    samples_deleted: totalDeleted,
    cap_reached: capReached,
  }
  logInfo('cron.prune-hr-samples', 'run complete', outcome)

  await stampHeartbeat('prune-hr-samples', outcome)
  return NextResponse.json({ success: true, data: outcome })
}
