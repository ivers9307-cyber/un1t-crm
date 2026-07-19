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
        payload: payload ?? {},
        error: error == null ? null : String(error?.message || error).slice(0, 2000),
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
