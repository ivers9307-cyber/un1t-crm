// webhook-dead-letter.js — best-effort capture of webhook events that 200'd
// the provider but failed to PROCESS. Keeps them visible for ops triage.
//
// CONTRACT:
//   • Never throws — a dead-letter write failure must NOT turn a 200 into a 500.
//   • Never blocks the webhook response (fire once, no retries here).
//   • QSTASH.3: replayable rows also get a fire-and-forget QStash push so
//     the replay happens in ~60s instead of waiting for the cron sweep.
//     The push is an optimisation ONLY — publish failure (or QSTASH_TOKEN
//     unset) leaves the row for /api/cron/webhook-replay exactly as before.

import { logWarn } from '@/lib/log'
import { isReplayable } from '@/lib/webhook-replay'
import { publishQueuePush, WEBHOOK_REPLAY_WORKER_PATH } from '@/lib/qstash'
import { sanitizeDbText, sanitizeJsonForDb } from '@/lib/db-safe-text'

/**
 * Best-effort location for an OUTBOUND email event: the send log row already
 * carries the location the mail belonged to, keyed by Postmark's MessageID.
 * DEADLETTER-LOC.1 — dead-letter rows with no location_id are invisible to
 * the per-location integration-health count, so the capture paths stamp one
 * wherever it is knowable. Never throws; null when unknowable (which the
 * health pane now counts anyway, via its NULL-inclusive filter).
 *
 * @param {object} db service-role supabase client
 * @param {string|null|undefined} postmarkMessageId
 * @returns {Promise<string|null>}
 */
export async function resolveEmailSendLocation(db, postmarkMessageId) {
  if (!postmarkMessageId) return null
  try {
    const { data } = await db
      .from('email_sends')
      .select('location_id')
      .eq('postmark_message_id', postmarkMessageId)
      .limit(1)
    return data?.[0]?.location_id ?? null
  } catch {
    return null
  }
}

/**
 * Record a webhook event that 200'd the provider but failed to PROCESS, so it
 * is captured (not silently lost) and visible. Best-effort — NEVER throws and
 * NEVER blocks the webhook response (a dead-letter write failure must not turn
 * a 200 into a 500).
 *
 * @param {object} db    service-role supabase client
 * @param {{ provider: string, eventType?: string, payload: any, error?: any, locationId?: string }} args
 */
export async function deadLetterWebhook(db, {
  provider,
  eventType = null,
  payload,
  error = null,
  locationId = null,
}) {
  try {
    const { data: inserted, error: insErr } = await db
      .from('webhook_dead_letter')
      .insert({
        provider,
        event_type: eventType,
        // EMAIL-INBOUND-POISON.1: jsonb rejects NUL and lone surrogates, and
        // the payloads most likely to need capturing are exactly the poison
        // ones that carry them — unsanitised, this insert failed on precisely
        // the events it exists to keep.
        payload: sanitizeJsonForDb(payload ?? {}),
        error: error == null ? null : sanitizeDbText(String(error?.message || error)).slice(0, 2000),
        location_id: locationId,
        last_attempt_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (insErr) {
      logWarn('webhook-dead-letter', 'capture failed', { provider, err: insErr })
      return
    }

    // QSTASH.3 — push the replay. Nudge QStash to deliver this row to
    // the replay worker instead of waiting for the */5 cron sweep.
    // 60s delay so the first replay respects the original minimum
    // backoff; dedup id is DASH-ONLY (QStash 400s on colons — the
    // QSTASH.2 lesson). Own try/catch: a publish problem must never
    // affect the dead-letter path's own error handling.
    if (inserted?.id && isReplayable(provider)) {
      try {
        await publishQueuePush({
          path: WEBHOOK_REPLAY_WORKER_PATH,
          body: { id: inserted.id },
          deduplicationId: `webhook-replay-${inserted.id}`,
          delaySeconds: 60,
        })
      } catch {
        // publishQueuePush swallows its own errors; belt-and-braces only.
      }
    }
  } catch (e) {
    logWarn('webhook-dead-letter', 'capture threw', { provider, err: e })
  }
}
