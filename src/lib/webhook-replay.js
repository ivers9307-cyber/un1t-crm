// webhook-replay.js — dead-letter replay registry + driver.
//
// Re-drivers redo the exact capture write the handler dead-lettered on. Only
// providers whose replay is idempotent are registered (idempotency review:
// inbody upsert + postmark re-queue are safe; glofox action-replay is NOT).
//
// INBODY: dead-letters when the inbody_webhook_events UPSERT fails.
//   Replay = redo that same upsert (onConflict ignoreDuplicates → idempotent).
//
// POSTMARK: dead-letters when the postmark_webhook_queue INSERT fails.
//   Replay = re-insert the raw payload into the queue (the drain cron dedupes
//   via recordWebhookEvent before queueing, but at dead-letter time the dedup
//   already succeeded — this is a pure queue-insert retry, safe to repeat).
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

    await db
      .from('webhook_dead_letter')
      .update({
        attempts:        newAttempts,
        error:           String(e?.message || e).slice(0, 2000),
        last_attempt_at: now,
        status:          nextStatus,
      })
      .eq('id', row.id)

    return { ok: false, status: nextStatus }
  }
}
