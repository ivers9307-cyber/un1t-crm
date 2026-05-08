// race-contact-linking — find-or-create the contact for a race
// team_member (mig 086).
//
// Insert path also fires the status_change sequence trigger with
// oldStatus=null so operators can build "on first race signup,
// enrol in welcome sequence" automations through the portal.
//
// Used by every code path that writes a team_members row with an
// email: public race signup (captain + every member), manual
// operator-add at /api/races/[id]/teams, member edits at
// /api/team-members/[id], and adds at /api/teams/[id]/members.
//
// The single rule: every team_member with an email has a
// contact_id pointing at someone in the contacts table. Match by
// case-insensitive email at the team's location; create with
// lead_status='competition_competitor' if no match.
//
// Returns the contact_id (string|null). Best-effort — never
// throws. Caller is expected to update team_members.contact_id
// itself; this helper only cares about the contacts row.

import { logWarn } from './log'

const COMPETITOR_LEAD_STATUS = 'competition_competitor'

/**
 * Find an existing contact at the location with the given email,
 * or create a fresh one with lead_status='competition_competitor'.
 * Returns the contact_id (or null on hard failure).
 *
 * IMPORTANT: existing contacts are NOT modified. If the email
 * already belongs to a contact with lead_status='member' (or any
 * other status), we link the team_member to it without changing
 * the lead_status. The new value only applies to CREATE, never
 * to UPDATE — existing taxonomy classifications take precedence.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db          service-role client
 * @param {string} args.locationId          where to scope the lookup
 * @param {string|null} [args.email]        normalised case is fine; we'll lower-case
 * @param {string|null} [args.name]
 * @param {string|null} [args.phone]
 * @returns {Promise<string|null>}
 */
export async function findOrCreateRaceContact({ db, locationId, email, name = null, phone = null }) {
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

    // No match here. Try a global match (in case the contact lives
    // at a sibling location in the same org). Don't change
    // location_id — the contact stays where it is, the
    // team_members row just points across.
    const { data: anywhere } = await db
      .from('contacts')
      .select('id')
      .ilike('email', normalised)
      .maybeSingle()
    if (anywhere?.id) return anywhere.id

    // Create. New contact picks up the competition_competitor
    // lead_status so retargeting + reporting can distinguish them
    // from gym members + trial leads.
    const { data: inserted, error } = await db
      .from('contacts')
      .insert({
        location_id: locationId,
        name: name || 'Race competitor',
        email: normalised,
        phone: phone || null,
        lead_status: COMPETITOR_LEAD_STATUS,
        source: 'race_signup',
        lead_source: 'website',
      })
      .select('id')
      .single()
    if (error) {
      logWarn('race-contact-linking', `insert failed for ${normalised}`, { err: error })
      return null
    }
    const newId = inserted?.id || null
    if (newId) {
      // Fire the status_change sequence trigger with oldStatus=null
      // so any "when contact becomes X" sequence picks the new
      // competitor up. Best-effort — never blocks the create.
      // Imported lazily to dodge any circular-import surprise
      // between sequences ↔ contact-linking.
      try {
        const { triggerSequencesForStatusChange } = await import('./sequences')
        await triggerSequencesForStatusChange(newId, null, COMPETITOR_LEAD_STATUS)
      } catch (e) {
        logWarn('race-contact-linking', `sequence trigger failed`, { err: e })
      }
    }
    return newId
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

export const __test = { COMPETITOR_LEAD_STATUS }
