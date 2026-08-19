// ZOOMSYNC.4 — the second half of the failing-forever fix: what happens when
// Zoom refuses a write that DID pass validation.
//
// A Zoom 400 is a verdict about the payload, not a blip: the same bytes will be
// refused on every retry, tonight and every night after, because the reconcile
// re-derives the same job from the same CRM row. That is the loop this parks.
//
// The mechanism is the one this repo already has — webhook_dead_letter (mig
// 315) — used with the same posture as `postmark_queue`: captured, VISIBLE, and
// deliberately NOT in src/lib/webhook-replay.js's registry. A replayer would
// re-run the identical write against the identical rules and fail identically;
// the fix for these rows lives in the CRM's phone field, in a human's hands.
// The admin route annotates any unregistered provider `replayable: false`, so
// /admin/webhook-dead-letter shows the row and offers Resolve, not Replay.
//
// Resolve is the un-park: loadParkedNumbers() only reads `pending` rows, so
// acknowledging one on that page puts the number back in the reconcile's way on
// the next run. That is the intended cycle — fix the number in the CRM, resolve
// the row, next night it syncs.

import { logWarn } from '@/lib/log'

/** provider key on webhook_dead_letter. Absent from REPLAYERS on purpose. */
export const ZOOM_SYNC_PROVIDER = 'zoom_contact_sync'

// A parked row per bad number; the live population is ~12. The cap is a
// runaway backstop, not a real bound — if it were ever hit the reconcile would
// simply retry the numbers past it, which is today's behaviour anyway.
const PARKED_LIMIT = 1000

/**
 * Is this Zoom HTTP status a permanent verdict on the payload?
 *
 * 4xx means Zoom read the request and refused it, so retrying is pointless —
 * with three exceptions that are about US or the moment, not the payload:
 *   401 — our token; zoomFetch already re-mints once, and a rotated credential
 *         heals it. QStash must keep retrying.
 *   408 — Zoom timed out reading the request.
 *   429 — rate limited. zoomFetch retries once honouring Retry-After; past
 *         that the queue's own retry is exactly right.
 * 5xx and a thrown/absent status are transient by definition.
 *
 * 404 and 409 never reach here — external-contacts.js folds them into ok:true,
 * because "already gone" and "already there" are the desired end states.
 */
export function isPermanentZoomFailure(status) {
  if (!Number.isFinite(status)) return false
  if (status === 401 || status === 408 || status === 429) return false
  return status >= 400 && status < 500
}

/**
 * E.164 numbers with a pending permanent failure recorded against them.
 *
 * Best-effort by design: this is a suppression list, and failing to read it
 * must not stop the sync. An empty set on error means the run behaves exactly
 * as it does today (re-enqueue, fail, park again) rather than skipping writes
 * it should have made — the failure mode is a wasted job, not a missing
 * directory entry.
 *
 * @returns {Promise<Set<string>>}
 */
export async function loadParkedNumbers(db) {
  const parked = new Set()
  if (!db) return parked
  try {
    // Supabase builders are thenables, not Promises — no .catch() here.
    const { data, error } = await db
      .from('webhook_dead_letter')
      .select('payload')
      .eq('provider', ZOOM_SYNC_PROVIDER)
      .eq('status', 'pending')
      .limit(PARKED_LIMIT)
    if (error) {
      logWarn('zoom-failures', 'parked read failed', { err: error.message })
      return parked
    }
    for (const row of data || []) {
      const e164 = row?.payload?.e164
      if (typeof e164 === 'string' && e164) parked.add(e164)
    }
  } catch (err) {
    logWarn('zoom-failures', 'parked read threw', { err: err?.message })
  }
  return parked
}
