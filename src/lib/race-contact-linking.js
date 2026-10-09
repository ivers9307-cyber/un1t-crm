// race-contact-linking — find-or-create the contact for a race
// team_member (mig 086).
//
// Used by every code path that writes a team_members row with an
// email: public race signup (captain + every member), manual
// operator-add at /api/events/[id]/teams, member edits at
// /api/team-members/[id], and adds at /api/teams/[id]/members.
//
// The single rule: every team_member with an email has a
// contact_id pointing at someone in the contacts table. Match by
// case-insensitive email at the team's location, else anywhere in its
// organisation (W0.6: never beyond it); create otherwise.
//
// CLASSIFY.2: lead_status is decommissioned. New contacts get their
// pipeline_stage_slug derived from the deal trigger when a deal is
// later attached. Race signups arrive with no deal, so they sit at
// pipeline_stage_slug=NULL until classified — that's fine for the
// "show me everyone who signed up for a race" reporting path
// (audience filters on lead_source='website' + tags).
//
// Returns the contact_id (string|null). Best-effort — never
// throws. Caller is expected to update team_members.contact_id
// itself; this helper only cares about the contacts row.

import { logWarn } from './log'
import { splitName } from './name-utils'
import { escapeLikePattern } from './like-escape'

/**
 * Find an existing contact at the location with the given email,
 * or create a fresh one. Returns the contact_id (or null on hard
 * failure).
 *
 * IMPORTANT: existing contacts are NOT modified. If the email
 * already belongs to a contact, we link the team_member to it
 * without touching the existing row.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db          service-role client
 * @param {string} args.locationId          where to scope the lookup
 * @param {string|null} [args.email]        normalised case is fine; we'll lower-case
 * @param {string|null} [args.name]
 * @param {string|null} [args.phone]
 * @param {boolean} [args.restrictToLocation=false]  when true, skip the
 *        sibling-location email fallback and match at this location only.
 * @param {boolean} [args.restrictToOrg=false]  LEADCAP.1 — match at this
 *        location first, then fall back to sibling locations in the SAME
 *        organisation, never globally. Since W0.6 this is the DEFAULT for
 *        every caller (`contacts_email_org_unique`, mig 712, is unique per
 *        organisation, so a match outside the org is another tenant's person,
 *        never this one); the flag is kept only so a public-form call site
 *        reads as the org-scoped lookup it is. It never widens anything.
 *        restrictToLocation still narrows to the one location.
 * @param {object} [args.insertFields={}]  extra columns stamped onto the
 *        contact INSERT only (HOST-MASTER.4: e.g. { automations_exempt: true }
 *        for host-sourced signups). NEVER applied to a matched existing
 *        contact — matches keep their settings untouched.
 * @returns {Promise<string|null>}
 */
/**
 * Resolve an email to a contact at any location in the SAME organisation as
 * locationId. Two hops (location → org → its locations) rather than a
 * PostgREST embed: the embed form is ambiguous once a table has ≥2 FKs and
 * the explicit .in('location_id', …) keeps the query legibly location-scoped.
 * Returns the contact_id or null; never throws.
 */
async function findContactInOrg(db, locationId, normalisedEmail) {
  const { data: loc } = await db
    .from('locations')
    .select('organization_id')
    .eq('id', locationId)
    .maybeSingle()
  const orgId = loc?.organization_id
  if (!orgId) return null

  const { data: siblings } = await db.from('locations').select('id').eq('organization_id', orgId)
  const ids = (siblings || []).map((l) => l.id).filter(Boolean)
  if (!ids.length) return null

  const { data: match } = await db
    .from('contacts')
    .select('id')
    .ilike('email', escapeLikePattern(normalisedEmail))
    .in('location_id', ids)
    .maybeSingle()
  return match?.id || null
}

// `restrictToOrg` is accepted and deliberately not read: the org-scoped lookup
// is the default (W0.6). Call sites keep passing it so they read as the
// public-form rule they implement.
export async function findOrCreateRaceContact({ db, locationId, email, name = null, phone = null, restrictToLocation = false, insertFields = {} }) {
  if (!email || typeof email !== 'string') return null
  const normalised = email.toLowerCase().trim()
  if (!normalised || !normalised.includes('@')) return null
  if (!locationId) return null

  try {
    // Match at this location first.
    //
    // escapeLikePattern on all three lookups here: `email` arrives from PUBLIC
    // forms (leads, class-booking, host-list subscribe, event/race register).
    // Unescaped, a wildcard address resolves to somebody else's contact and the
    // caller then links a team_member / lead / booking to that stranger — the
    // same IDOR the restrictToLocation flag below exists to prevent, reached by
    // a different route. See src/lib/like-escape.js.
    const { data: existing } = await db
      .from('contacts')
      .select('id')
      .eq('location_id', locationId)
      .ilike('email', escapeLikePattern(normalised))
      .maybeSingle()
    if (existing?.id) return existing.id

    // No match here. Unless the caller restricts to this location, try the
    // sibling locations in the same organisation. Don't change location_id —
    // the contact stays where it is, the team_members row just points across.
    if (!restrictToLocation) {
      // W0.6 — org-wide is the WIDEST any caller may resolve, public or
      // staff: contacts_email_org_unique (mig 712) is per organisation, so
      // a match outside it is another tenant's person, never this one.
      const sibling = await findContactInOrg(db, locationId, normalised)
      if (sibling) return sibling
    }

    // Create. CLASSIFY.2: no lead_status / pipeline_stage_slug set
    // here. The deal trigger (mig 155) will populate
    // pipeline_stage_slug if a deal is later attached. Race-signup
    // audience targeting works off lead_source='website' + tags.
    // Split the single signup name into first/last so the contact
    // edit form and the "Create in Glofox" gate (both read
    // first_name/last_name) work — mirrors /api/contacts. A blank
    // name leaves first/last null and falls back to the 'Race
    // competitor' placeholder for the required `name` column.
    const { firstName, lastName } = splitName(name)
    const { data: inserted, error } = await db
      .from('contacts')
      .insert({
        location_id: locationId,
        name: name || 'Race competitor',
        first_name: firstName,
        last_name: lastName,
        email: normalised,
        phone: phone || null,
        source: 'race_signup',
        lead_source: 'website',
        ...insertFields,
      })
      .select('id')
      .single()
    if (error) {
      // 23505 = contacts_email_org_unique (mig 712): this email already
      // exists in this ORGANISATION. That can only be a concurrent insert
      // racing us in-org (two rapid submits), or a row outside the org
      // under a half-applied schema. Re-check in-org and adopt the winner;
      // otherwise fail closed rather than link across organisations.
      if (error.code === '23505') {
        const raced = await findContactInOrg(db, locationId, normalised)
        if (raced) return raced
        logWarn('race-contact-linking', `email exists outside this org, refusing to link: ${normalised}`, { locationId })
        return null
      }
      logWarn('race-contact-linking', `insert failed for ${normalised}`, { err: error })
      return null
    }
    return inserted?.id || null
  } catch (e) {
    logWarn('race-contact-linking', `threw`, { err: e })
    return null
  }
}

/**
 * Bulk version — given a list of { name, email } members, returns
 * an array of the same length where each entry is { ...member,
 * contact_id }. Order preserved. null email → contact_id stays null.
 */
export async function resolveContactsForRoster({ db, locationId, members }) {
  const out = []
  for (const m of members || []) {
    const contact_id = await findOrCreateRaceContact({
      db,
      locationId,
      email: m?.email || null,
      name: m?.name || null,
      phone: m?.phone || null,
    })
    out.push({ ...m, contact_id })
  }
  return out
}

