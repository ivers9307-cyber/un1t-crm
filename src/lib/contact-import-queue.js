// Shared contact_imports job processing (QSTASH.4).
//
// Extracted verbatim from the process-contact-imports cron's per-job
// logic so the QStash worker route and the cron share ONE
// claim/process/stamp implementation — the two consumers can run
// concurrently against the same table precisely because they go
// through this CAS.
//
// Claim semantics: flip status 'pending'→'processing' (+ fresh
// started_processing_at), conditioned on status still being 'pending' —
// the same status CAS the cron has always used, now keyed by id.
// Exactly one claimant wins; the loser matches 0 rows and skips.
//
// Unlike the postmark queue there is NO release-on-failure: a failed
// import is stamped 'failed' with its error_message for the operator
// (imports are not blindly retryable — part of the batch may already be
// written). A consumer that CRASHES mid-run (function timeout, deploy)
// leaves the row in 'processing'; the cron's stuck-recovery pass —
// deliberately CRON-ONLY — resets it to 'pending' after
// STUCK_AFTER_MINUTES.

import { runImportCommit } from './contact-import-runner.js'

// 'processing' older than this = crashed consumer; the cron's
// stuck-recovery pass resets it to 'pending'.
export const STUCK_AFTER_MINUTES = 5

/**
 * Claim one import job, run it, stamp completed/failed.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {{id: string, location_id: string, payload: object|null}} job —
 *   a full contact_imports row (the payload carries the stored CSV)
 * @returns {Promise<{status: 'processed'|'skipped'|'failed', error?: string, missingPayload?: true}>}
 */
export async function claimAndProcessImportJob(db, job) {
  const { data: claimed } = await db
    .from('contact_imports')
    .update({
      status: 'processing',
      started_processing_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  if (!job.payload) {
    // Shouldn't happen — the commit route always writes payload
    // when status='pending'. Fail loudly so we notice.
    await db.from('contact_imports').update({
      status: 'failed',
      error_message: 'Pending job had no payload.',
    }).eq('id', job.id)
    return { status: 'failed', error: 'Job missing payload', missingPayload: true }
  }

  const { mapping, rows, batchTag, resolutions } = job.payload

  try {
    const { counts } = await runImportCommit(db, {
      importId: job.id,
      locationId: job.location_id,
      mapping, rows, batchTag, resolutions,
    })
    await db.from('contact_imports').update({
      status: 'completed',
      created_count: counts.created,
      updated_count: counts.updated,
      skipped_count: counts.skipped,
      errored_count: counts.errored,
      // Drop the payload — it's served its purpose, no point
      // hanging onto a copy of every imported CSV forever.
      payload: null,
    }).eq('id', job.id)
    return { status: 'processed' }
  } catch (e) {
    const error = (e?.message || String(e)).slice(0, 2000)
    await db.from('contact_imports').update({
      status: 'failed',
      error_message: error,
    }).eq('id', job.id)
    return { status: 'failed', error }
  }
}
