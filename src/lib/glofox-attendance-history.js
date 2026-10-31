// ATTHISTORY.1 — the one-time full Glofox booking-history read, per contact.
//
// WHY
// ───
// Every Glofox booking read in the CRM is a 30-day window, so "has this person
// ever attended a class here?" had no answer for most of a studio's list: on
// 31 Oct 2026, 658 of 8,851 Stillorgan contacts carried last_attended_at, and
// a former member whose last class predates the CRM looked like a lead who
// never came in. The Stillorgan marketing segments (been in → win-back, never
// been in → trial nurture) rest on exactly that split.
//
// WHAT
// ────
// /api/cron/glofox-attendance-history reads every page of /2.0/bookings back
// ten years ONCE for each Glofox-linked contact at a Glofox studio
// (fetchUserBookingHistoryResult), and writes historyPatch(): last_attended_at
// / last_booked_at advance-only (mergeBookingAggregates; never regressed), the
// windowed 7-/30-day counts left to glofox-attendance-refresh, which owns them,
// and glofox_history_synced_at (mig 793) stamped WHATEVER the answer — a read,
// no bookings, a failed read — so the cursor advances on every attempt
// (DETAILBACKFILL.1). The failed contacts are listed on the run's
// glofox_sync_runs row for a hand-run second pass.
//
// After the sweep, `last_attended_at IS NULL` on a stamped contact means
// Glofox holds no attended class for them: the audience builder's existing
// last_attended_at is_null / is_not_null is the segment split.
import { computeBookingAggregates, mergeBookingAggregates } from '@/lib/glofox-sync'
import { scopeToGlofoxStudio } from '@/lib/glofox-crossover'

/** The columns the route reads per candidate (the merge compares against them). */
export const HISTORY_CANDIDATE_COLUMNS = 'id, glofox_member_id, last_attended_at, last_booked_at'

/** Candidates a tick takes. Under the 1,000-row cap, so one ordered page is the tick. */
export const HISTORY_PER_TICK = 600

/** Failed contact ids kept on the audit row (enough to re-null by hand). */
export const HISTORY_FAILED_IDS_CAP = 200

/**
 * The patch for one contact after its history read.
 *
 *   existing  the contact row (HISTORY_CANDIDATE_COLUMNS)
 *   bookings  the full Booking[] (may be empty), or null when the read FAILED
 *   now       the stamp instant (Date or ISO string)
 *
 * Advance-only on the two timestamps: a stored date is never regressed, and a
 * failed or empty read changes neither. Never writes the windowed counts.
 * Always stamps glofox_history_synced_at.
 */
export function historyPatch(existing, bookings, now = new Date()) {
  const stamp = now instanceof Date ? now.toISOString() : String(now)
  const patch = { glofox_history_synced_at: stamp }
  if (!Array.isArray(bookings) || bookings.length === 0) return patch
  const merged = mergeBookingAggregates(existing, computeBookingAggregates(bookings))
  if (merged.last_attended_at) patch.last_attended_at = merged.last_attended_at
  if (merged.last_booked_at) patch.last_booked_at = merged.last_booked_at
  return patch
}

/** True when the history holds at least one attended class. */
export function historyHasAttendance(bookings) {
  return Array.isArray(bookings) && bookings.some((b) => b?.attended === true)
}

/**
 * One tick's candidates at a Glofox studio: Glofox-linked, never read, oldest
 * contact first (`id` the stable tiebreak). Sibling-studio Glofox members
 * (crossoverIds, GLOFOXREADERS.1) are included like every other Glofox reader.
 * Throws on a failed read: the route marks the location failed and withholds
 * the heartbeat, because a tick that could not list its work did none.
 */
export async function listHistoryCandidates(db, locationId, crossoverIds = [], perTick = HISTORY_PER_TICK) {
  const { data, error } = await scopeToGlofoxStudio(db
    .from('contacts')
    .select(HISTORY_CANDIDATE_COLUMNS), locationId, crossoverIds)
    .not('glofox_member_id', 'is', null)
    .is('glofox_history_synced_at', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(perTick)
  if (error) throw new Error(error.message)
  return data || []
}

/** How many at the studio are still unread. null when the count failed (never 0). */
export async function countHistoryRemaining(db, locationId, crossoverIds = []) {
  const { count, error } = await scopeToGlofoxStudio(db
    .from('contacts')
    .select('id', { count: 'exact', head: true }), locationId, crossoverIds)
    .not('glofox_member_id', 'is', null)
    .is('glofox_history_synced_at', null)
  if (error) return null
  return count ?? null
}

/** The heartbeat's last_outcome, summed over the studios a tick ran. */
export function historyOutcome(perLocation, budgetExhausted, glofoxHttp, skippedSummary = {}) {
  const sum = (k) => perLocation.reduce((n, r) => n + (r.summary?.[k] ?? 0), 0)
  const remaining = perLocation.some((r) => r.remaining === null || r.remaining === undefined)
    ? null
    : perLocation.reduce((n, r) => n + r.remaining, 0)
  return {
    ...skippedSummary,
    eligible: perLocation.reduce((n, r) => n + (r.eligible ?? 0), 0),
    read: sum('read'),
    no_bookings: sum('no_bookings'),
    attended: sum('attended'),
    truncated: sum('truncated'),
    fetch_failed: sum('fetch_failed'),
    update_failed: sum('update_failed'),
    failed_locations: perLocation.filter((r) => r.status === 'failed').length,
    remaining,
    budget_exhausted: budgetExhausted,
    glofox_http: glofoxHttp,
  }
}
