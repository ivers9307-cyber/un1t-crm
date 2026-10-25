// ORGCONTACTS.2 — the one query the contacts list (src/app/(sales)/contacts/
// page.js) and /api/contacts/search build: public.studio_contacts (mig 765),
// contacts joined to their contact_studios rows, filtered on the studio.
//
// Before, both read `contacts` with `or(location_id.eq.L, id.in.(<ids>))`,
// the ids from the crossover_contact_ids RPC, capped at 100 because they
// travelled as a GET URL (a 414 past that). The view carries every
// relationship at the studio (decision 2: any, lapsed too), so a studio's
// list is one equality filter and studio_is_crossover (the contact's primary
// studio is not this one) is a display fact the pill reads, not an access
// path. Service-role callers only: the view is closed to client sessions.

// PERF.2 — the explicit field set ContactsTable + ContactsView consume. Keep
// the page and the search route on this one list.
// studio_stage_slug (ORGCONTACTS.4, decision 3): the stage AT this studio, the
// column the page filters on and the chip shows; pipeline_stage_slug is the
// contact-wide stage (the primary studio's), kept for the classifier chips.
export const CONTACT_LIST_FIELDS = 'id, name, email, phone, lead_source, pipeline_stage_slug, studio_stage_slug, trial_credits_remaining, created_at, location_id, glofox_membership_status, person_group_id'

function base(db, { locationId, primaryOnly }) {
  if (!db) throw new TypeError('studio-contacts-query: db is required')
  if (!locationId) throw new TypeError('studio-contacts-query: locationId is required')
  return (q) => {
    q = q.eq('studio_location_id', locationId)
    // CONTACT-DEDUP (mig 334): lookup callers fold each linked person to one
    // row (the group primary); reach callers leave every account visible.
    if (primaryOnly) q = q.eq('is_primary_contact', true)
    return q
  }
}

/**
 * The list query: the list fields plus studio_is_crossover, filtered on the
 * studio. Filters only; the caller layers search, order and range (Supabase
 * JS drops the filter methods once .order / .range are in the chain).
 */
export function listStudioContactsQuery(db, { locationId, primaryOnly = false, columns = CONTACT_LIST_FIELDS } = {}) {
  const scope = base(db, { locationId, primaryOnly })
  return scope(db.from('studio_contacts').select(`${columns}, studio_is_crossover`))
}

/** The same WHERE as a head count, so the count reflects what the operator sees. */
export function countStudioContactsQuery(db, { locationId, primaryOnly = false } = {}) {
  const scope = base(db, { locationId, primaryOnly })
  return scope(db.from('studio_contacts').select('id', { count: 'exact', head: true }))
}
