// Shared webhook_dead_letter row processing (QSTASH.3).
//
// Extracted from the replay cron's per-row loop so the QStash worker
// route and the cron share ONE claim/process/release implementation —
// the two consumers can run concurrently against the same table
// precisely because they go through this CAS.
//
// Claim semantics: webhook_dead_letter (mig 315) has no 'replaying'
// status (check constraint: pending/resolved/failed/discarded), so the
// claim flips last_attempt_at forward ONLY where it still equals the
// value the caller read (IS NULL for never-attempted rows) AND status is
// still 'pending'. Exactly one claimant matches; the loser matches 0
// rows and skips. Release is replayDeadLetter's own bookkeeping: success
// → status 'resolved'; failure → attempts+1 + fresh last_attempt_at with
// status 'pending' (or 'failed' at the budget), which restores cron
// eligibility after the usual min(60·2^attempts, 3600)s backoff window.
// A crash between claim and release leaves the row pending with only a
// bumped last_attempt_at — the cron retries it after backoff; nothing
// can wedge in a claimed-forever state.

import { isReplayable, replayDeadLetter, REPLAYABLE_PROVIDERS } from './webhook-replay.js'

export const MAX_ATTEMPTS = 5 // give up (status 'failed') after this many attempts per row

export { REPLAYABLE_PROVIDERS }

/**
 * Claim one dead-letter row, replay it, release on failure.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {{id: number, provider: string, payload: object, status: string,
 *          attempts: number, last_attempt_at: string|null}} row
 * @returns {Promise<{status: 'processed'|'skipped'|'failed', error?: string}>}
 */
export async function claimAndReplayDeadLetterRow(db, row) {
  // Belt + suspenders: both consumers filter their fetch to replayable
  // providers, but a non-replayable row must never be claimed (flipping
  // its last_attempt_at would be an unexplained write on a glofox row).
  if (!isReplayable(row.provider)) return { status: 'skipped' }

  let claim = db
    .from('webhook_dead_letter')
    .update({ last_attempt_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'pending')
  claim = row.last_attempt_at == null
    ? claim.is('last_attempt_at', null)
    : claim.eq('last_attempt_at', row.last_attempt_at)
  const { data: claimed } = await claim.select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  const result = await replayDeadLetter(db, row, { maxAttempts: MAX_ATTEMPTS })
  if (result.ok) return { status: 'processed' }
  return { status: 'failed', error: result.error || 'unknown' }
}
