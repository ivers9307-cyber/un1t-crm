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
// RESOLVE — and ONLY resolve — is the un-park. /admin/webhook-dead-letter
// offers two acknowledgements and they mean opposite things here:
//   "Mark resolved" = the operator fixed the phone number on the contact. The
//     suppression must lift so the next run can publish it. That is the cycle
//     this feature is built around.
//   "Discard"       = the operator decided this number is not going to be
//     fixed (a junk import, a member who is gone). That is precisely the case
//     where suppression must PERSIST — and the first draft of this file, by
//     filtering on status='pending' alone, made Discard the one button that
//     restarted the nightly failure loop it exists to end: re-enqueue, Zoom
//     400, a NEW pending row, every night, one extra dead-letter row each time.
// So the filter below is "everything except resolved", not "pending".

import { logWarn } from '@/lib/log'

/** provider key on webhook_dead_letter. Absent from REPLAYERS on purpose. */
export const ZOOM_SYNC_PROVIDER = 'zoom_contact_sync'

/**
 * The statuses that still suppress. Mig 315's CHECK constraint allows exactly
 * four, so this is the complement of ['resolved'] spelled out — an explicit
 * list rather than a .neq() so that adding a fifth status later is a decision
 * someone has to make here, not a default that silently un-parks.
 */
export const PARKING_STATUSES = Object.freeze(['pending', 'failed', 'discarded'])

// A parked row per bad number. With validation now running before enqueue the
// steady-state population is single digits, and PARK_BUDGET below caps it far
// under this. The cap is a runaway backstop; the .order() next to it is what
// makes crossing it degrade deterministically (oldest parks keep their
// suppression) instead of returning an arbitrary subset.
const PARKED_LIMIT = 1000

/**
 * How many parked rows this provider may hold before the worker stops parking
 * and starts failing loudly instead. See parkingBudgetExhausted().
 *
 * Sized against the measured population: the nightly permanent-failure floor
 * was ~10-13 creates, of which validation now catches 12 before they are ever
 * enqueued. Anything approaching 50 is not a set of bad phone numbers, it is
 * Zoom refusing us wholesale.
 */
export const PARK_BUDGET = 50

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
      .in('status', PARKING_STATUSES)
      // Deterministic truncation. Without an explicit order PostgREST's row
      // order past LIMIT is whatever the plan produces, so the suppression set
      // would be an arbitrary subset that changes between runs — the numbers
      // that fell outside it would re-enqueue, fail, and insert yet another
      // row. Oldest first: a long-standing park keeps its suppression.
      .order('received_at', { ascending: true })
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

/**
 * Has this provider parked so much that parking has stopped being triage?
 *
 * isPermanentZoomFailure() reads a 4xx as a verdict on the PAYLOAD, which is
 * right for the per-number 400 this feature was built for. But the identical
 * status comes back when Zoom is refusing us at the ACCOUNT level — a dropped
 * phone:write:external_contact scope, a lapsed Zoom Phone plan, an
 * external-contact quota. Then every write 4xxs, and on a cold start that is
 * ~6,300 of them. Parking each one would launder an outage that a credential
 * fix would clear in a minute into thousands of PERMANENT per-number
 * suppressions, one dead-letter row each, recoverable only row by row.
 *
 * So parking gets a budget. Past it the worker stops parking and returns 500,
 * which is the honest classification: something systemic is wrong, QStash
 * retries, the errors stay in the Vercel log, and NOTHING is suppressed. A
 * loud transient beats a quiet permanent one — the failure mode we are
 * escaping is exactly the quiet kind.
 *
 * FAILS OPEN (returns false) when the count cannot be read: the per-number
 * parking is the primary fix for the live loop and must not be disabled by a
 * flaky count query. The budget is a backstop for a rarer, louder failure.
 *
 * @returns {Promise<boolean>}
 */
export async function parkingBudgetExhausted(db) {
  if (!db) return false
  try {
    // head:true + count — options are only read on the FIRST .select() after
    // .from(), so they go here and no rows come back over the wire.
    const { count, error } = await db
      .from('webhook_dead_letter')
      .select('id', { count: 'exact', head: true })
      .eq('provider', ZOOM_SYNC_PROVIDER)
      .in('status', PARKING_STATUSES)
    if (error) {
      logWarn('zoom-failures', 'park budget read failed', { err: error.message })
      return false
    }
    return Number.isFinite(count) && count >= PARK_BUDGET
  } catch (err) {
    logWarn('zoom-failures', 'park budget read threw', { err: err?.message })
    return false
  }
}
