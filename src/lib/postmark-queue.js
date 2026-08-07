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
//
// POSTMARK-DLQ.1 — exhaustion is a CAPTURED event, not a disappearance.
// Both consumers select `.lt('attempts', MAX_ATTEMPTS)`, so the attempt that
// takes a row TO MAX_ATTEMPTS stops it matching either query: it is never
// retried and never alerted, and Postmark already got its 200 so the provider
// will never re-send it either. These rows carry Bounce (hard-bounce
// suppression + auto-unsubscribe), SpamComplaint (auto-unsubscribe) and
// SubscriptionChange (the RFC 8058 one-click unsubscribe) — silently losing
// one means we keep emailing someone who asked us to stop, and stop
// suppressing addresses that damage sender reputation for every location. So
// the transition to exhausted dead-letters the raw payload FIRST, while the
// row is still in hand.

import { processPostmarkEvent } from './postmark-webhook-processor.js'
import { deadLetterWebhook } from './webhook-dead-letter.js'
import { logError } from './log.js'

export const MAX_ATTEMPTS = 5 // give up after this many failures per event

/**
 * Dead-letter provider key for a queue row that burned its retry budget.
 *
 * DELIBERATELY NOT 'postmark'. That key is registered auto-replayable in
 * src/lib/webhook-replay.js and its re-driver INSERTs the payload back into
 * postmark_webhook_queue — which would mint a fresh row with attempts = 0,
 * resetting the very budget that just ran out, so a permanently-failing
 * payload loops (exhaust → dead-letter → re-queue → exhaust …) with no
 * terminal state. Worse, replayDeadLetter marks the row `resolved` as soon as
 * that INSERT succeeds: honest for the ingest failure 'postmark' actually
 * covers (where the queue insert was the whole job), a lie here, where
 * re-queued ≠ processed. That would recreate the silent loss one layer up.
 * 'postmark_queue' has no re-driver, so the row stays `pending` and visible on
 * /api/admin/webhook-dead-letter until a human deals with it — the same
 * reasoning that put the inbound handler on 'postmark_inbound'.
 */
export const EXHAUSTED_PROVIDER = 'postmark_queue'

/**
 * Stamped on postmark_webhook_queue.error at exhaustion so an exhausted row is
 * distinguishable from one merely mid-retry without a new column (`attempts >=
 * MAX_ATTEMPTS` says the same thing, but only the error text survives a glance
 * at the row). processed_at stays NULL: the event was NOT processed, and
 * claiming otherwise would hide it from every backlog query too.
 */
export const EXHAUSTED_ERROR_PREFIX = 'dead_lettered_after_max_attempts'

/**
 * Capture an exhausted row's payload before the attempts bump makes it
 * unselectable. webhook_events stores no payload, so this dead-letter row is
 * the ONLY copy of the event once the queue row goes invisible — the payload
 * is stored verbatim (exactly what processPostmarkEvent takes) so a re-drive
 * is a straight copy back into the queue, with the queue-row forensics in the
 * error text rather than wrapped around the body.
 *
 * Never throws and never masks the original processing error.
 */
async function captureExhaustedRow(db, row, { attempts, error }) {
  try {
    await deadLetterWebhook(db, {
      provider: EXHAUSTED_PROVIDER,
      eventType: row?.payload?.RecordType || 'unknown',
      payload: row?.payload ?? {},
      error: `postmark_webhook_queue row ${row?.id} exhausted after ${attempts} attempts: ${error}`,
    })
  } catch (e) {
    // deadLetterWebhook is contractually never-throwing; this holds the line
    // even if that ever changes. try/catch, not `.catch()` — supabase-js
    // builders are thenables without a .catch, and a rejection here must not
    // turn a failed attempt into an exception or overwrite `error`.
    logError('postmark-queue', 'dead-letter capture failed', { id: row?.id, err: e })
  }
}

/**
 * Claim one queue row, process it, release on failure.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {{id: string, payload: object, attempts: number}} row
 * @returns {Promise<{status: 'processed'|'skipped'|'failed', error?: string, attempts?: number, deadLettered?: boolean}>}
 */
export async function claimAndProcessQueueRow(db, row) {
  const { data: claimed } = await db
    .from('postmark_webhook_queue')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('processed_at', null)
    .select('id, attempts')
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  const result = await processPostmarkEvent(db, row.payload)
  if (result.ok) return { status: 'processed' }

  const error = result.error || 'unknown'

  // Attempts as the DB holds them at claim time, not as the caller
  // snapshotted them. The consumers race by design: a batch selected before
  // someone else's failed attempt released the row carries a stale count, and
  // re-deriving "next" from it would dead-letter the same exhaustion twice.
  // The CAS already round-trips, so reading attempts back costs nothing.
  const claimedAttempts = claimed[0]?.attempts
  const prevAttempts = typeof claimedAttempts === 'number' && Number.isFinite(claimedAttempts)
    ? claimedAttempts
    : (Number(row.attempts) || 0)
  const attempts = prevAttempts + 1

  // Exactly at the transition — never on a later sweep. In practice both
  // consumers filter exhausted rows out, so a row at MAX_ATTEMPTS should
  // never reach here again; the `prevAttempts <` half makes "capture once"
  // a property of this function rather than of every caller's WHERE clause.
  const deadLettered = prevAttempts < MAX_ATTEMPTS && attempts >= MAX_ATTEMPTS
  if (deadLettered) {
    logError('postmark-queue', 'queue row exhausted — dead-lettered', {
      id: row?.id,
      recordType: row?.payload?.RecordType || 'unknown',
      attempts,
      err: error,
    })
    await captureExhaustedRow(db, row, { attempts, error })
  }

  await db
    .from('postmark_webhook_queue')
    .update({
      processed_at: null,
      attempts,
      error: deadLettered ? `${EXHAUSTED_ERROR_PREFIX}: ${error}` : error,
    })
    .eq('id', row.id)
  return { status: 'failed', error, attempts, deadLettered }
}
