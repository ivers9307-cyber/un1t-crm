// DETAILBACKFILL.1 — the cursor for /api/cron/glofox-detail-backfill.
//
// The backfill used to pick "glofox_membership_plan IS NULL or glofox_synced_at
// older than 14 days", plan-NULL first, in one select PostgREST caps at 1,000
// rows. 2,926 contacts legitimately have no plan (PAYG, ClassPass, trials), so
// they filled every page and were re-read every ~30 minutes forever (~288k
// Glofox calls and ~143k contact UPDATEs a day), while 2,917 contacts with a
// plan went unrefreshed from 3 Jul (measured 27 Sep 2026).
//
// Now each contact carries contacts.glofox_detail_due_at (mig 645): when the
// backfill next wants it. The cron stamps it after EVERY attempt, whatever the
// answer, so no answer (no plan, a Glofox refusal, a 404) can pin a contact to
// the front of the queue. NULL = never attempted = due now.
//
// Pure: no I/O, no clock of its own (both are parameters, for tests).

/** Contacts read per tick. One explicitly ordered page: stays < 1,000. */
export const DETAIL_PER_TICK = 100
/** Mean days between two reads of a contact Glofox answered for. */
export const DETAIL_SWEEP_DAYS = 14
/** Hours before a failed read (non-2xx, network, write error) is retried. */
export const DETAIL_RETRY_HOURS = 6

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

// Outcomes where Glofox gave its answer: asking again sooner changes nothing.
// 'member_refused' is C11's 200 success:false ("Resource not available").
const ANSWERED = new Set(['create', 'update', 'leave', 'member_refused', 'ambiguous', 'invalid'])

/**
 * When this contact is next due, given the outcome of the attempt just made.
 *   answered → now + DETAIL_SWEEP_DAYS × (0.75 + 0.5·rand)  (10.5–17.5 d)
 *   anything else (fetch_failed, error, unknown) → now + DETAIL_RETRY_HOURS
 * The jitter spreads the first full sweep (~11 h) over a week on the next pass,
 * so the load does not come back as a wave every fortnight.
 *
 * @param {string} outcome
 * @param {number} [nowMs]
 * @param {() => number} [rand]  in [0, 1); clamped
 * @returns {string} ISO UTC timestamp
 */
export function nextDetailDueAt(outcome, nowMs = Date.now(), rand = Math.random) {
  if (!ANSWERED.has(outcome)) {
    return new Date(nowMs + DETAIL_RETRY_HOURS * HOUR_MS).toISOString()
  }
  let r = Number(rand())
  if (!Number.isFinite(r) || r < 0) r = 0
  if (r >= 1) r = 0.999999
  const days = DETAIL_SWEEP_DAYS * (0.75 + 0.5 * r)
  return new Date(nowMs + Math.round(days * DAY_MS)).toISOString()
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

/**
 * The PostgREST `.or()` predicate for "due now": never attempted, or the due
 * time has passed. Deliberately says nothing about the plan.
 *
 * @param {string} nowIso  a UTC ISO timestamp (it is spliced into or=(…))
 */
export function detailDueFilter(nowIso) {
  if (typeof nowIso !== 'string' || !ISO_UTC.test(nowIso)) {
    throw new Error(`detailDueFilter: not a UTC ISO timestamp: ${String(nowIso)}`)
  }
  return `glofox_detail_due_at.is.null,glofox_detail_due_at.lte.${nowIso}`
}
