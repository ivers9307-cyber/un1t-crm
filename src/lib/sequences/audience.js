// Audience-match check used by every status-change / tag-added /
// race-* trigger before enrolling a contact.
//
// Implemented as a 1-row reachability check: we apply the
// audience_filter to a query that's already filtered to a single
// contact_id, then ask Postgres `count(*)`. If 1, the contact
// matches. If 0, they don't. We don't need to run the filter
// across the whole contacts table — single-row evaluation is
// dramatically cheaper for the cron path which calls this
// hundreds-to-thousands of times per tick.
//
// Sequences with no filter (the common case — `filter` is null,
// undefined, or has no `filters` array) match everyone.

import { applyAudienceFilterAsync, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { logWarn } from '@/lib/log'

/**
 * @param {object} db                                 Service-role Supabase client.
 * @param {string} contactId                          The contact whose match we're testing.
 * @param {object | null | undefined} filter          { logic, filters: [{ field, op, value }] }
 * @returns {Promise<boolean>}
 */
export async function contactMatchesSequenceAudience(db, contactId, filter) {
  if (!filter?.filters?.length) return true

  // Look up the contact's location so tag-filter resolution can be
  // location-scoped (cheaper than scanning contact_tags org-wide
  // when a sequence has a `tag` filter — see mig 085).
  const { data: contact } = await db
    .from('contacts')
    .select('location_id')
    .eq('id', contactId)
    .maybeSingle()

  let query = db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('id', contactId)

  try {
    query = await applyAudienceFilterAsync({
      db,
      query,
      filter,
      locationId: contact?.location_id || null,
    })
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      // A bad filter shouldn't crash the cron — treat as no-match
      // (the safer direction, "nobody gets enrolled" beats "everybody
      // gets enrolled by accident").
      logWarn('sequences', 'sequence has invalid audience_filter, treating as no-match', { err: e })
      return false
    }
    throw e
  }

  const { count } = await query
  return (count ?? 0) > 0
}
