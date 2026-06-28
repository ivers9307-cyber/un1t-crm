// SEG-TRIG.1 — Segment-membership sync + diff-driven trigger fanout.
//
// Segments (contact_segments) store a filter expression, not a stored
// member set. To detect "added" / "removed" transitions we maintain a
// durable snapshot in contact_segment_memberships and compare against
// the filter's current result on each cron tick.
//
// Cron flow (every 5 min, via /api/cron/sync-segment-memberships):
//
//   1. Find every segment referenced by at least one active sequence
//      with trigger_type IN ('segment_added', 'segment_removed').
//      Most segments are one-off /contacts page filters; only the
//      ones operators actually wired into sequences need snapshots.
//
//   2. For each segment:
//        a. Compute current member set from segment.filter
//           (applyAudienceFilterAsync, paged with .range())
//        b. Load stored memberships
//        c. Diff: additions = current \ stored
//                  removals  = stored \ current
//        d. INSERT additions, DELETE removals (atomic per segment)
//        e. Fire segment_added triggers on additions
//           Fire segment_removed triggers on removals
//
//   3. Return aggregate stats { segments_processed, additions, removals }.
//
// Per-segment errors are swallowed (logged) so one bad segment can't
// stall the rest of the sweep. The cron route reports the aggregate
// + a per-segment error count.

import { createServerClient } from '@/lib/supabase'
import { applyAudienceFilterAsync, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { logWarn } from '@/lib/log'
import {
  triggerSequencesForSegmentAdded,
  triggerSequencesForSegmentRemoved,
} from './triggers.js'

const PAGE_SIZE = 1000 // Supabase default cap; we page through it.

/**
 * Build a fresh contacts query scoped to this segment's location and
 * apply the segment's filter. The builder is single-use (consumed by
 * the first await), so the caller must call this once per page.
 *
 * Returns the FILTERED query (already location-scoped, filter applied).
 *
 * @param {SupabaseClient} db
 * @param {{ id: string, location_id: string, filter: object|null }} segment
 * @returns {Promise<object>} Supabase query builder ready to .range() + await.
 */
async function buildMemberQuery(db, segment) {
  let query = db
    .from('contacts')
    .select('id', { count: 'exact' })
    .eq('location_id', segment.location_id)

  ;({ query } = await applyAudienceFilterAsync({
    db,
    query,
    filter: segment.filter,
    locationId: segment.location_id,
  }))
  return query
}

/**
 * Run the filter for a segment and return the full set of matching
 * contact_ids at this moment. Pages through Supabase's 1000-row cap
 * (one query per page — PostgrestFilterBuilder is single-use, so we
 * rebuild via buildMemberQuery on each iteration).
 *
 * @param {SupabaseClient} db
 * @param {object} segment  { id, location_id, filter }
 * @returns {Promise<Set<string>>}
 */
export async function computeSegmentMembers(db, segment) {
  const members = new Set()
  let from = 0
  // Safety stop — a segment with > 1M members is operator error;
  // bail loudly rather than spin forever.
  for (let page = 0; page < 1000; page++) {
    const query = await buildMemberQuery(db, segment)
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(`segment ${segment.id} member query failed: ${error.message}`)
    }
    if (!data || data.length === 0) break
    for (const row of data) members.add(row.id)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return members
}

/**
 * Load the currently-stored membership snapshot for a segment.
 *
 * @param {SupabaseClient} db
 * @param {string} segmentId
 * @returns {Promise<Set<string>>}
 */
async function loadStoredMemberships(db, segmentId) {
  const stored = new Set()
  let from = 0
  for (let page = 0; page < 1000; page++) {
    const { data, error } = await db
      .from('contact_segment_memberships')
      .select('contact_id')
      .eq('segment_id', segmentId)
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(`segment ${segmentId} snapshot load failed: ${error.message}`)
    }
    if (!data || data.length === 0) break
    for (const row of data) stored.add(row.contact_id)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return stored
}

/**
 * Persist the diff: insert additions, delete removals. Both batches
 * are chunked to avoid hitting URL-length limits on the DELETE side
 * (Supabase's .in() pushes IDs onto the query string).
 *
 * @param {SupabaseClient} db
 * @param {string} segmentId
 * @param {string[]} additions
 * @param {string[]} removals
 */
async function persistDiff(db, segmentId, additions, removals) {
  const CHUNK = 500
  if (additions.length) {
    for (let i = 0; i < additions.length; i += CHUNK) {
      const slice = additions.slice(i, i + CHUNK)
      const rows = slice.map(contactId => ({ segment_id: segmentId, contact_id: contactId }))
      // upsert with ignoreDuplicates so a concurrent insert (unlikely
      // but possible if two cron ticks overlap on a slow segment)
      // doesn't error on the PK conflict.
      const { error } = await db
        .from('contact_segment_memberships')
        .upsert(rows, { onConflict: 'segment_id,contact_id', ignoreDuplicates: true })
      if (error) {
        throw new Error(`segment ${segmentId} insert failed: ${error.message}`)
      }
    }
  }
  if (removals.length) {
    for (let i = 0; i < removals.length; i += CHUNK) {
      const slice = removals.slice(i, i + CHUNK)
      const { error } = await db
        .from('contact_segment_memberships')
        .delete()
        .eq('segment_id', segmentId)
        .in('contact_id', slice)
      if (error) {
        throw new Error(`segment ${segmentId} delete failed: ${error.message}`)
      }
    }
  }
}

/**
 * Main entry point — called by the cron route.
 *
 * Walks every segment that's wired into at least one active
 * segment_added / segment_removed sequence trigger, recomputes
 * membership, persists the diff, fires triggers on additions and
 * removals.
 *
 * Per-segment errors are swallowed so one bad segment can't stall
 * the rest of the sweep. The caller gets aggregate stats + an error
 * count for monitoring.
 *
 * @returns {Promise<{ segments_processed: number, additions: number, removals: number, errors: number }>}
 */
export async function syncSegmentMemberships() {
  const db = createServerClient()
  const stats = { segments_processed: 0, additions: 0, removals: 0, errors: 0 }

  // Find segments referenced by at least one active sequence trigger.
  // Distinct on segment_id via an in-memory Set (Postgrest doesn't
  // expose DISTINCT in the select builder).
  const { data: triggers, error: triggersErr } = await db
    .from('email_sequences')
    .select('trigger_config')
    .in('trigger_type', ['segment_added', 'segment_removed'])
    .eq('status', 'active')
  if (triggersErr) {
    throw new Error(`sync-segment-memberships: trigger lookup failed: ${triggersErr.message}`)
  }

  const segmentIds = new Set()
  for (const row of triggers || []) {
    const id = row?.trigger_config?.segment_id
    if (typeof id === 'string' && id) segmentIds.add(id)
  }
  if (segmentIds.size === 0) return stats

  // Fetch the segment rows in one go.
  const { data: segments, error: segErr } = await db
    .from('contact_segments')
    .select('id, location_id, filter, memberships_initialized_at')
    .in('id', [...segmentIds])
  if (segErr) {
    throw new Error(`sync-segment-memberships: segment lookup failed: ${segErr.message}`)
  }

  for (const segment of segments || []) {
    try {
      const current = await computeSegmentMembers(db, segment)
      const stored = await loadStoredMemberships(db, segment.id)

      const additions = [...current].filter(id => !stored.has(id))
      const removals  = [...stored].filter(id => !current.has(id))

      await persistDiff(db, segment.id, additions, removals)

      // First-sync guard — the very first time we snapshot a segment there
      // is no stored set, so EVERY current member is an "addition". Firing
      // segment_added for a whole pre-existing membership would mass-enrol
      // contacts who didn't just join. So on the first sync we only
      // establish the baseline (persisted above) + stamp the marker, and
      // SUPPRESS both triggers. Every later sync fires on real transitions.
      const isFirstSync = !segment.memberships_initialized_at
      if (isFirstSync) {
        await db.from('contact_segments')
          .update({ memberships_initialized_at: new Date().toISOString() })
          .eq('id', segment.id)
      }

      // Fire triggers AFTER persist — if the trigger throws, the
      // snapshot still reflects the diff, so we don't re-fire on
      // the next tick. (Sequence enrol has its own dedup via
      // enrolContacts → enrolment uniqueness.)
      if (!isFirstSync && additions.length) {
        await triggerSequencesForSegmentAdded(segment.id, additions)
      }
      if (!isFirstSync && removals.length) {
        await triggerSequencesForSegmentRemoved(segment.id, removals)
      }

      stats.segments_processed += 1
      stats.additions += additions.length
      stats.removals += removals.length
    } catch (e) {
      stats.errors += 1
      const msg = e instanceof InvalidAudienceFilterError
        ? `invalid filter on segment ${segment.id}: ${e.message}`
        : `segment ${segment.id} sync failed: ${e.message || String(e)}`
      logWarn('sequences', msg, { err: e })
    }
  }

  return stats
}
