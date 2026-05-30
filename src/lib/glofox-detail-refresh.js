// Glofox per-member DETAIL refresh (GLOFOX4.1).
//
// The nightly glofox-sync cron pulls only the lightweight /members
// LIST shape, so rich detail (plan name, type, membership_state =
// paused/locked, price, billing interval, pack credits) only ever
// landed for contacts that triggered a webhook. This module powers a
// resumable, concurrency-limited drainer that pulls /members/:id
// detail for the whole ever-member/trial/pack/classpass cohort —
// NULLS-first as a one-time backfill, then re-pulling stale rows as a
// safety net for any webhook Glofox fails to deliver.
//
// applyMemberSync already persists all the detail fields (preserve-on-
// null) and runs credit-member detection + deal placement, so this
// module just feeds it the rich by-id record and stamps the cursor.
import { fetchMemberById } from './glofox.js'
import { applyMemberSync } from './glofox-sync.js'

// Option B cohort: everyone who has ever been a member / trial / pack
// / classpass. Pure cold/dead leads (lead, cold, tour, no_sale_tour)
// are intentionally skipped — they have no membership to describe, so
// pulling detail for them would waste ~1.9k calls/cycle for null data.
export const DETAIL_COHORT_STATUSES = [
  'member',
  'credit_member',
  'trial',
  'no_sale_trial',
  'classpass_payg',
  'ex_member',
]

/**
 * Fetch the next batch of cohort contacts needing a detail refresh,
 * ordered by freshness (never-synced first, then stalest). When
 * `staleBefore` (ISO string) is given, only rows that were never
 * synced OR synced before that cutoff are returned — that's the
 * steady-state safety-net mode once the initial backfill is done.
 *
 * Returns [{ id, glofox_member_id, location_id }].
 */
export async function selectDetailRefreshBatch(db, { limit = 600, staleBefore = null } = {}) {
  let q = db
    .from('contacts')
    .select('id, glofox_member_id, location_id')
    .not('glofox_member_id', 'is', null)
    .in('glofox_membership_status', DETAIL_COHORT_STATUSES)
  if (staleBefore) {
    q = q.or(`glofox_detail_synced_at.is.null,glofox_detail_synced_at.lt.${staleBefore}`)
  }
  q = q
    .order('glofox_detail_synced_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  const { data, error } = await q
  if (error) throw new Error(`selectDetailRefreshBatch: ${error.message}`)
  return data || []
}

/**
 * Run `fn` over `items` with a fixed max concurrency. Never lets more
 * than `concurrency` promises be in flight at once. Returns settled
 * results in input order: [{ status: 'fulfilled', value } | { status:
 * 'rejected', reason }]. A single failure never rejects the batch.
 */
export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) }
      } catch (e) {
        results[i] = { status: 'rejected', reason: e }
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

/**
 * Refresh one contact's Glofox detail. Pulls the full /members/:id
 * record, runs the canonical applyMemberSync (persists plan/type/
 * state/price + credit detection + deal placement), then stamps
 * glofox_detail_synced_at so the drainer advances.
 *
 * A 404 (member deleted in Glofox) still stamps the cursor — leaving
 * existing data untouched — so we stop re-pulling a dead id every run.
 *
 * Returns 'synced' | 'gone' | 'skipped'.
 */
export async function refreshOneContact(db, contact, creds, opts = {}) {
  const { membershipCache = null, now = () => new Date().toISOString() } = opts
  const memberId = contact?.glofox_member_id
  const locationId = contact?.location_id
  if (!memberId || !locationId) return 'skipped'

  const member = await fetchMemberById(creds, memberId)
  if (!member) {
    await db.from('contacts').update({ glofox_detail_synced_at: now() }).eq('id', contact.id)
    return 'gone'
  }
  await applyMemberSync(db, locationId, member, { creds, membershipCache })
  await db.from('contacts').update({ glofox_detail_synced_at: now() }).eq('id', contact.id)
  return 'synced'
}
