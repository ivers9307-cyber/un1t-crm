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
// case-insensitive email at the team's location; create otherwise.
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
 *        cross-location email fallback. Public, unauthenticated lead/booking
 *        forms set this so a known email can't resolve an existing person at
 *        another location (and then have attribution/consent/a deal written
 *        against them) — an IDOR on a public write path.
 * @param {object} [args.insertFields={}]  extra columns stamped onto the
 *        contact INSERT only (HOST-MASTER.4: e.g. { automations_exempt: true }
 *        for host-sourced signups). NEVER applied to a matched existing
 *        contact — matches keep their settings untouched.
 * @returns {Promise<string|null>}
 */
export async function findOrCreateRaceContact({ db, locationId, email, name = null, phone = null, restrictToLocation = false, insertFields = {} }) {
  if (!email || typeof email !== 'string') return null
  const normalised = email.toLowerCase().trim()
  if (!normalised || !normalised.includes('@')) return null
  if (!locationId) return null

  try {
    // Match at this location first.
    const { data: existing } = await db
      .from('contacts')
      .select('id')
      .eq('location_id', locationId)
      .ilike('email', normalised)
      .maybeSingle()
    if (existing?.id) return existing.id

    // No match here. Unless the caller restricts to this location, try a
    // global match (the contact may live at a sibling location in the same
    // org). Don't change location_id — the contact stays where it is, the
    // team_members row just points across. Public lead/booking forms set
    // restrictToLocation so they never resolve a cross-location contact from a
    // bare email (IDOR).
    if (!restrictToLocation) {
      const { data: anywhere } = await db
        .from('contacts')
        .select('id')
        .ilike('email', normalised)
        .maybeSingle()
      if (anywhere?.id) return anywhere.id
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

