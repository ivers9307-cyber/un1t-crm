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

import { parseInbodyNotification } from '@/lib/inbody-webhook'

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
 * Returns true when a provider has a registered idempotent re-driver.
 * Glofox and any unknown provider returns false.
 */
export function isReplayable(provider) {
  return Object.prototype.hasOwnProperty.call(REPLAYERS, provider)
}

// ── core replay ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 5

/**
 * Replay one dead-letter row.
 *
 * On success → status='resolved', resolved_at = NOW(), attempts++.
 * On failure → attempts++, error updated, last_attempt_at = NOW();
 *              status stays 'pending' unless attempts >= maxAttempts (→ 'failed').
 *
 * Returns { ok: boolean, status: string }.
 *
 * @param {object} db     service-role supabase client
 * @param {object} row    dead-letter row (must have id, provider, payload, attempts)
 * @param {{ maxAttempts?: number }} opts
 */
export async function replayDeadLetter(db, row, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const replayer = REPLAYERS[row.provider]
  if (!replayer) {
    return { ok: false, status: row.status || 'pending' }
  }

  const now = new Date().toISOString()
  const newAttempts = (row.attempts || 1) + 1

  try {
    await replayer(db, row.payload)

    // Success — mark resolved.
    await db
      .from('webhook_dead_letter')
      .update({
        status:       'resolved',
        resolved_at:  now,
        attempts:     newAttempts,
        last_attempt_at: now,
      })
      .eq('id', row.id)

    return { ok: true, status: 'resolved' }
  } catch (e) {
    // Failure — bump attempts, maybe promote to 'failed'.
    const nextStatus = newAttempts >= maxAttempts ? 'failed' : 'pending'
    const errMsg = String(e?.message || e).slice(0, 2000)

    await db
      .from('webhook_dead_letter')
      .update({
        attempts:        newAttempts,
        error:           errMsg,
        last_attempt_at: now,
        status:          nextStatus,
      })
      .eq('id', row.id)

    // error surfaced (QSTASH.3) so the queue lib / worker 500 body is
    // diagnosable from QStash + Vercel logs, not just the table row.
    return { ok: false, status: nextStatus, error: errMsg }
  }
}
