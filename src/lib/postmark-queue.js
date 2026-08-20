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
import { deadLetterWebhook, resolveEmailSendLocation } from './webhook-dead-letter.js'
import { SEND_ROW_NOT_YET_COMMITTED } from './postmark-send-marker.js'
import { logError } from './log.js'

export const MAX_ATTEMPTS = 5 // give up after this many failures per event

// ── POSTMARK-QUEUE-RECLAIM.1 — making "died mid-claim" distinguishable ──
// The table has no completion column, so `processed_at set` used to mean BOTH
// "successfully processed" and "claimed by an attempt that died" (consumer
// killed mid-processing, or the release UPDATE below failed — it was never
// inspected). Those stranded rows carry bounces, spam complaints and one-click
// unsubscribes, Postmark already got its 200, and both consumers skip
// non-NULL processed_at: invisible forever, the exact class POSTMARK-DLQ.1
// exists to prevent.
//
// Code-only fix, no DDL: the claim CAS stamps this marker into `error`; the
// success path clears it. A row with `processed_at` set AND the marker still
// present is therefore a claim whose owner never finished — reclaimable once
// it is older than any live attempt can be. Rows written by older code never
// carry the marker, so a deploy overlap can only under-reclaim, never falsely
// reclaim a genuinely processed row.
export const CLAIMED_ERROR_MARKER = 'claimed_in_flight'

// A claim older than this cannot belong to a live consumer: the cron and the
// QStash worker both run inside Vercel's function timeout (≤ 300s). 10 min
// keeps a comfortable margin and the sweep runs every cron tick.
export const STALE_QUEUE_CLAIM_MS = 10 * 60_000

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
      // DEADLETTER-LOC.1 — the send this event belongs to knows its location;
      // without it the row is invisible to the per-location health count.
      // Best-effort (never throws): a payload whose send can't be found stays
      // NULL, which the health pane now counts anyway.
      locationId: await resolveEmailSendLocation(db, row?.payload?.MessageID),
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
 * @returns {Promise<{status: 'processed'|'skipped'|'failed'|'deferred', error?: string, attempts?: number, deadLettered?: boolean}>}
 */
export async function claimAndProcessQueueRow(db, row) {
  const { data: claimed } = await db
    .from('postmark_webhook_queue')
    .update({ processed_at: new Date().toISOString(), error: CLAIMED_ERROR_MARKER })
    .eq('id', row.id)
    .is('processed_at', null)
    .select('id, attempts')
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  const result = await processPostmarkEvent(db, row.payload)
  if (result.ok) {
    // Completion stamp — clearing the marker is what says "done" rather than
    // "died holding the claim". Checked but never fatal: the event WAS
    // handled, and a row that keeps the marker is merely re-processed by the
    // stale sweep, which the release path below already makes designed-in.
    try {
      const { error: doneErr } = await db
        .from('postmark_webhook_queue')
        .update({ error: null })
        .eq('id', row.id)
      if (doneErr) {
        logError('postmark-queue', 'completion stamp failed — the stale sweep will re-process this row', {
          id: row.id, err: doneErr,
        })
      }
    } catch (e) {
      logError('postmark-queue', 'completion stamp threw — the stale sweep will re-process this row', {
        id: row.id, err: e,
      })
    }
    return { status: 'processed' }
  }

  const error = result.error || 'unknown'

  // POSTMARK-RACE.1 — "the row has not committed yet" is a failure, but not a
  // FAULT. It travels the identical release path (claim given back, attempts++,
  // dead-lettered if it spends the budget) — that bounding is what stops a
  // marker on mail whose insert genuinely died from looping forever. The only
  // thing the distinct status changes is what the QStash worker does next: it
  // answers 200 instead of 500 (so QStash retires the message rather than
  // spending its own fast retries inside a window it cannot outrun) and
  // re-publishes the row to itself with a 60s delay — ~4.5x the worst commit
  // lag ever measured (13.2s) instead of racing it. The sweeper cron sits
  // behind that as the guarantee for a QStash outage; it is NOT the primary
  // recovery path, because at BATCH_SIZE/10min it cannot absorb a campaign
  // burst (POSTMARK-RACE.2).
  //
  // The EXHAUSTING attempt is deliberately not deferred (see below): once the
  // budget is spent the row is dead-lettered and terminal, and reporting that
  // as a 200 would hide a genuine incident — a send whose email_sends insert
  // never landed at all — behind a routine-looking response.

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
  const deferred = error === SEND_ROW_NOT_YET_COMMITTED && !deadLettered
  if (deadLettered) {
    logError('postmark-queue', 'queue row exhausted — dead-lettered', {
      id: row?.id,
      recordType: row?.payload?.RecordType || 'unknown',
      attempts,
      err: error,
    })
    await captureExhaustedRow(db, row, { attempts, error })
  }

  // The release used to be fire-and-forget: an UPDATE that errored here left
  // the row claimed forever, looking processed, with its bounce/unsubscribe
  // never handled. Checked now, retried once (a transient blip is the common
  // case), and if both fail the row still carries CLAIMED_ERROR_MARKER, so
  // the stale sweep reclaims it — logged loudly either way. The original
  // processing error is never masked.
  const releasePayload = {
    processed_at: null,
    attempts,
    error: deadLettered ? `${EXHAUSTED_ERROR_PREFIX}: ${error}` : error,
  }
  const released = await releaseQueueClaim(db, row.id, releasePayload)
  if (!released) {
    const retried = await releaseQueueClaim(db, row.id, releasePayload)
    if (!retried) {
      logError('postmark-queue', 'CLAIM RELEASE FAILED twice — row stays claimed until the stale sweep reclaims it', {
        id: row.id, attempts, err: error,
      })
    }
  }
  return { status: deferred ? 'deferred' : 'failed', error, attempts, deadLettered }
}

/** One release attempt. Never throws; true = the UPDATE reported success. */
async function releaseQueueClaim(db, id, payload) {
  try {
    const { error } = await db
      .from('postmark_webhook_queue')
      .update(payload)
      .eq('id', id)
    if (error) {
      logError('postmark-queue', 'claim release failed', { id, err: error })
      return false
    }
    return true
  } catch (e) {
    logError('postmark-queue', 'claim release threw', { id, err: e })
    return false
  }
}

/**
 * Give back claims whose owners died — POSTMARK-QUEUE-RECLAIM.1.
 *
 * A row with `processed_at` set and CLAIMED_ERROR_MARKER still in `error` is a
 * claim that was never completed (consumer killed mid-processing) and never
 * released (the release UPDATE failed twice). Once it is older than any live
 * attempt can be, flip it back to pending with attempts+1 so the ordinary
 * consumers retry it — and if that +1 spends the budget, dead-letter the
 * payload FIRST, exactly like a normal exhausting attempt (these rows carry
 * bounces and one-click unsubscribes; losing one means we keep mailing someone
 * who asked us to stop).
 *
 * Race-safe: the release is guarded on `error` still being the marker, so an
 * overlapping cron tick reclaims each row at most once. (Both ticks may have
 * captured an exhausting row's dead-letter — capture-before-release is the
 * POSTMARK-DLQ.1 ordering, and a duplicate capture beats a lost one.)
 *
 * Never throws — the cron calls this before its batch and must never be taken
 * down by it.
 *
 * @returns {Promise<{reclaimed: number, deadLettered: number, failed: number}>}
 */
export async function reclaimStaleQueueClaims(db, { staleMs = STALE_QUEUE_CLAIM_MS, limit = 50 } = {}) {
  const summary = { reclaimed: 0, deadLettered: 0, failed: 0 }
  let rows
  try {
    const cutoff = new Date(Date.now() - staleMs).toISOString()
    const { data, error } = await db
      .from('postmark_webhook_queue')
      .select('id, payload, attempts')
      .eq('error', CLAIMED_ERROR_MARKER)
      .not('processed_at', 'is', null)
      .lt('processed_at', cutoff)
      .order('processed_at', { ascending: true })
      .limit(limit)
    if (error) {
      logError('postmark-queue', 'stale-claim scan failed', { err: error })
      return summary
    }
    rows = data || []
  } catch (e) {
    logError('postmark-queue', 'stale-claim scan threw', { err: e })
    return summary
  }

  for (const row of rows) {
    try {
      const prevAttempts = Number(row.attempts) || 0
      const attempts = prevAttempts + 1
      const deadLettered = prevAttempts < MAX_ATTEMPTS && attempts >= MAX_ATTEMPTS
      if (deadLettered) {
        logError('postmark-queue', 'stale claim exhausted on reclaim — dead-lettered', {
          id: row?.id, recordType: row?.payload?.RecordType || 'unknown', attempts,
        })
        await captureExhaustedRow(db, row, { attempts, error: 'stale claim reclaimed' })
      }
      const { error } = await db
        .from('postmark_webhook_queue')
        .update({
          processed_at: null,
          attempts,
          error: deadLettered
            ? `${EXHAUSTED_ERROR_PREFIX}: stale claim reclaimed`
            : 'stale claim reclaimed',
        })
        .eq('id', row.id)
        .eq('error', CLAIMED_ERROR_MARKER)
        .select('id')
      if (error) {
        summary.failed += 1
        logError('postmark-queue', 'stale-claim release failed', { id: row?.id, err: error })
        continue
      }
      summary.reclaimed += 1
      if (deadLettered) summary.deadLettered += 1
    } catch (e) {
      summary.failed += 1
      logError('postmark-queue', 'stale-claim release threw', { id: row?.id, err: e })
    }
  }
  return summary
}
