// webhook-replay.js — dead-letter replay registry + driver.
//
// Re-drivers redo the exact capture write the handler dead-lettered on. Only
// providers whose replay is idempotent are registered (idempotency review:
// inbody upsert + postmark re-queue are safe; glofox action-replay is NOT).
//
// INBODY: dead-letters when the inbody_webhook_events UPSERT fails.
//   Replay = redo that same upsert (onConflict ignoreDuplicates → idempotent).
//
// POSTMARK: dead-letters when the postmark_webhook_queue INSERT fails — i.e.
//   the event never reached the queue at all. Replay = re-insert the raw
//   payload into the queue; a pure insert retry, safe to repeat.
//   It deliberately does NOT call recordWebhookEvent, and must never be
//   "fixed" to. Dedup happens ONCE, in /api/webhooks/postmark, BEFORE the
//   queue insert; neither the drain cron nor this replay dedups. By
//   dead-letter time that (RecordType:MessageID) claim has already been
//   recorded, and nothing prunes webhook_events — so re-recording here would
//   report `seen` and permanently no-op EVERY postmark replay.
//
//   NOT the key for a queue row that exhausted MAX_ATTEMPTS while PROCESSING:
//   those capture under 'postmark_queue' (src/lib/postmark-queue.js), which is
//   intentionally absent from this registry. Re-queueing one would mint a
//   fresh row with attempts = 0 — resetting the budget that just ran out, so a
//   permanently-failing payload never terminates — and replayDeadLetter would
//   stamp `resolved` on the successful INSERT, when nothing was processed.
//
// GLOFOX: dead-letters AFTER action processing throws (post-dedup). Re-running
//   actions risks partial-completion. EXCLUDED — not in this registry.
//
// POSTMARK_INBOUND (MAIL-DEADLETTER.1): replayable by an OPERATOR ONLY, so it
//   is in MANUAL_REPLAY_PROVIDERS and deliberately NOT in REPLAYERS. The cron
//   and the QStash worker filter on REPLAYABLE_PROVIDERS; a `no_matching_mailbox`
//   payload re-run every sweep would dead-letter again on every tick and burn
//   to 'failed' in 25 minutes, hiding the very row that needs a human to add
//   the mailbox. The re-driver itself lives beside the inbound pipeline
//   (replayInboundDeadLetter in the postmark-inbound route module — importing
//   it here would cycle through webhook-dead-letter.js) and is handed to
//   replayDeadLetter as `opts.replayer` by the admin replay route. Its
//   idempotency rests on the inbound pipeline's own dedupe classification
//   (EMAIL-DEDUPE-STALE.1): a held claim is classified, the unique index on
//   email_inbox_messages.postmark_message_id is the completion marker, and a
//   23505 lands in the finish-up path — so pressing Replay twice files nothing
//   twice.
//
// RE-DRIVER CONTRACT. A re-driver resolves to one of:
//   • undefined / { recorded: true, result? } — it recorded what the event
//     exists to record; the row is RESOLVED.
//   • { recorded: false, reason } — it ran cleanly and recorded NOTHING (the
//     inbound pipeline dead-lettering again, a claim still in flight). The row
//     is NOT resolved: attempts++, last_attempt_at, and the reason on `error`,
//     status untouched. Marking that resolved would be the CLAUDE.md invariant
//     ("a queued webhook event must NEVER be marked processed when it recorded
//     nothing"): the dedupe key is claimed, the provider's retry is gone, and a
//     green tick would destroy the event in silence.
//   • throws — a real failure; attempts++, error, and 'failed' at the budget.

import { parseInbodyNotification } from '@/lib/inbody-webhook'
import { logWarn } from '@/lib/log'

// ── re-driver helpers (exported for testing) ────────────────────────────────

/**
 * Re-run the inbody capture write: parse the stored payload and upsert into
 * inbody_webhook_events with the same columns + conflict target as the
 * original handler. Throws on a real DB error so replayDeadLetter can
 * record the failure.
 *
 * @param {object} db      service-role supabase client
 * @param {object} payload raw inbody notification body (from dead_letter row)
 */
export async function replayInbody(db, payload) {
  const n = parseInbodyNotification(payload)
  const { error } = await db
    .from('inbody_webhook_events')
    .upsert({
      account:       n.account,
      tel_hp:        n.telHp,
      user_id:       n.userId,
      test_datetime: n.testDatetime,
      equip:         n.equip,
      equip_serial:  n.equipSerial,
      is_temp_data:  n.isTempData,
      payload,
      processed:     false,
    }, { onConflict: 'account,user_id,test_datetime', ignoreDuplicates: true })

  if (error) throw new Error(error.message)
}

/**
 * Re-run the postmark capture write: insert the stored payload into the
 * webhook queue. The drain cron will pick it up as normal. Throws on error.
 *
 * @param {object} db      service-role supabase client
 * @param {object} payload raw postmark event body (from dead_letter row)
 */
export async function replayPostmark(db, payload) {
  const { error } = await db
    .from('postmark_webhook_queue')
    .insert({ payload })

  if (error) throw new Error(error.message)
}

// ── registry ────────────────────────────────────────────────────────────────

const REPLAYERS = {
  inbody:   replayInbody,
  postmark: replayPostmark,
  // glofox intentionally absent — action replay is NOT idempotent.
}

/**
 * The registry keys, exported for query filters (`.in('provider', …)`) so
 * the cron, the QStash worker and the dead-letter publish gate all share
 * ONE source of truth for which providers are auto-replayable (QSTASH.3).
 */
export const REPLAYABLE_PROVIDERS = Object.freeze(Object.keys(REPLAYERS))

/**
 * Returns true when a provider has a registered idempotent re-driver that the
 * AUTOMATIC consumers (cron, QStash worker) may run unattended.
 * Glofox and any unknown provider returns false.
 */
export function isReplayable(provider) {
  return Object.prototype.hasOwnProperty.call(REPLAYERS, provider)
}

/**
 * Providers an OPERATOR may replay from the morgue but nothing may replay on
 * its own (see the header). Keys only — the re-drivers live with their
 * pipelines and reach replayDeadLetter via `opts.replayer`.
 */
export const MANUAL_REPLAY_PROVIDERS = Object.freeze(['postmark_inbound'])

/**
 * Returns true when SOME replay path exists for the provider — automatic or
 * operator-triggered. This is what the morgue's Replay button keys on.
 */
export function isManuallyReplayable(provider) {
  return isReplayable(provider) || MANUAL_REPLAY_PROVIDERS.includes(provider)
}

// ── core replay ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 5

/**
 * Replay one dead-letter row.
 *
 * On success → status='resolved', resolved_at = NOW(), attempts++.
 * On "recorded nothing" → attempts++, error = reason, last_attempt_at = NOW();
 *              status UNTOUCHED (never promoted — see RE-DRIVER CONTRACT).
 * On failure → attempts++, error updated, last_attempt_at = NOW();
 *              status stays 'pending' unless attempts >= maxAttempts (→ 'failed').
 *
 * Returns { ok: boolean, status: string, recorded?, reason?, result?, error? }.
 *
 * The bookkeeping writes are CHECKED (BAREWRITE) but never fail the replay:
 * the event itself has already been re-driven by the time they run, and a
 * lost bookkeeping write is grounds for a loud log, not for reporting the
 * replay as failed (which would invite a re-run of work that succeeded).
 *
 * @param {object} db     service-role supabase client
 * @param {object} row    dead-letter row (must have id, provider, payload, attempts)
 * @param {{ maxAttempts?: number, replayer?: Function }} opts
 *   replayer — an explicit re-driver (operator-only providers). Defaults to
 *   the registry entry for row.provider.
 */
export async function replayDeadLetter(db, row, { maxAttempts = DEFAULT_MAX_ATTEMPTS, replayer } = {}) {
  const run = replayer || REPLAYERS[row.provider]
  if (!run) {
    return { ok: false, status: row.status || 'pending' }
  }

  const now = new Date().toISOString()
  const newAttempts = (row.attempts || 1) + 1

  let outcome
  try {
    outcome = await run(db, row.payload)
  } catch (e) {
    // Failure — bump attempts, maybe promote to 'failed'.
    const nextStatus = newAttempts >= maxAttempts ? 'failed' : 'pending'
    const errMsg = String(e?.message || e).slice(0, 2000)

    await recordAttempt(db, row, {
      attempts:        newAttempts,
      error:           errMsg,
      last_attempt_at: now,
      status:          nextStatus,
    })

    // error surfaced (QSTASH.3) so the queue lib / worker 500 body is
    // diagnosable from QStash + Vercel logs, not just the table row.
    return { ok: false, status: nextStatus, error: errMsg }
  }

  if (outcome && outcome.recorded === false) {
    // Ran, recorded nothing. The row stays exactly as open as it was.
    const reason = String(outcome.reason || 'no_op').slice(0, 200)
    await recordAttempt(db, row, {
      attempts:        newAttempts,
      error:           `replay_no_op: ${reason}`,
      last_attempt_at: now,
    })
    return { ok: false, status: row.status || 'pending', recorded: false, reason }
  }

  // Success — mark resolved.
  await recordAttempt(db, row, {
    status:          'resolved',
    resolved_at:     now,
    attempts:        newAttempts,
    last_attempt_at: now,
  })

  const out = { ok: true, status: 'resolved' }
  if (outcome && typeof outcome === 'object') {
    out.recorded = true
    if (outcome.result !== undefined) out.result = outcome.result
  }
  return out
}

/** The one bookkeeping write, checked and logged — never thrown. */
async function recordAttempt(db, row, patch) {
  try {
    const { error } = await db
      .from('webhook_dead_letter')
      .update(patch)
      .eq('id', row.id)
    if (error) {
      logWarn('webhook-replay', 'dead-letter bookkeeping write failed', { id: row.id, provider: row.provider, patch, err: error })
    }
  } catch (err) {
    logWarn('webhook-replay', 'dead-letter bookkeeping write threw', { id: row.id, provider: row.provider, patch, err })
  }
}
