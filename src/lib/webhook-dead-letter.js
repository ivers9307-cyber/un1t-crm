// webhook-dead-letter.js — best-effort capture of webhook events that 200'd
// the provider but failed to PROCESS. Keeps them visible for ops triage.
//
// CONTRACT:
//   • Never throws — a dead-letter write failure must NOT turn a 200 into a 500.
//   • Never blocks the webhook response (fire once, no retries here).
//   • Replay is Phase 2 (needs a per-provider idempotency pass).

import { logWarn } from '@/lib/log'

/**
 * Record a webhook event that 200'd the provider but failed to PROCESS, so it
 * is captured (not silently lost) and visible. Best-effort — NEVER throws and
 * NEVER blocks the webhook response (a dead-letter write failure must not turn
 * a 200 into a 500). Replay is Phase 2.
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
    const { error: insErr } = await db.from('webhook_dead_letter').insert({
      provider,
      event_type: eventType,
      payload: payload ?? {},
      error: error == null ? null : String(error?.message || error).slice(0, 2000),
      location_id: locationId,
      last_attempt_at: new Date().toISOString(),
    })
    if (insErr) logWarn('webhook-dead-letter', 'capture failed', { provider, err: insErr })
  } catch (e) {
    logWarn('webhook-dead-letter', 'capture threw', { provider, err: e })
  }
}
