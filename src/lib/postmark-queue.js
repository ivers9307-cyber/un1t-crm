// Shared postmark_webhook_queue row processing (QSTASH.1).
//
// Extracted verbatim from the drain cron's per-row loop so the QStash
// worker route and the cron share ONE claim/process/release
// implementation — the two consumers can run concurrently against the
// same queue table precisely because they go through this CAS.
//
// Claim semantics: flip processed_at NULL→now, conditioned on it still
// being NULL. Only one claimant wins; the loser matches 0 rows and
// skips. On processing failure the claim is released (processed_at back
// to NULL) with attempts+1 so the row retries until MAX_ATTEMPTS.

import { processPostmarkEvent } from './postmark-webhook-processor.js'

export const MAX_ATTEMPTS = 5 // give up after this many failures per event

/**
 * Claim one queue row, process it, release on failure.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {{id: string, payload: object, attempts: number}} row
 * @returns {Promise<{status: 'processed'|'skipped'|'failed', error?: string}>}
 */
export async function claimAndProcessQueueRow(db, row) {
  const { data: claimed } = await db
    .from('postmark_webhook_queue')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('processed_at', null)
    .select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  const result = await processPostmarkEvent(db, row.payload)
  if (result.ok) return { status: 'processed' }

  const error = result.error || 'unknown'
  await db
    .from('postmark_webhook_queue')
    .update({
      processed_at: null,
      attempts: (row.attempts || 0) + 1,
      error,
    })
    .eq('id', row.id)
  return { status: 'failed', error }
}
