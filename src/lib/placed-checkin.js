// FINDTEAM.8 (I2) — check-in for a placed solo follows them to their team.
//
// A solo entrant keeps their own registration after staff place them (status
// 'placed', placed_into_registration_id → the team entry they joined), and
// their confirmation email's QR still names that solo row. At the door the
// person must be checked in on the TEAM they now race with, never on the dead
// solo row: the scan and the manual check-in routes both resolve through here.
//
// The person is matched on the target team's member rows by contact_id, else
// by lower-cased email. No match means "not on this team"; the caller answers
// with its own refusal shape and never falls back to the solo row.

/**
 * @param {object} db  service-role client
 * @param {{ eventId: string, placedIntoId: string, person: { contact_id?: string|null, email?: string|null } }} args
 * @returns {Promise<{ ok: true, registrationId: string, member: { id: string, name?: string|null, email?: string|null, contact_id?: string|null } }
 *   | { ok: false, reason: 'load_failed'|'not_found'|'not_on_team' }>}
 */
export async function followPlacementForCheckin(db, { eventId, placedIntoId, person }) {
  if (!placedIntoId) return { ok: false, reason: 'not_found' }
  const { data: target, error } = await db
    .from('race_registrations')
    .select('id, race_event_id, teams ( id, team_members ( id, name, email, contact_id ) )')
    .eq('id', placedIntoId)
    .maybeSingle()
  if (error) return { ok: false, reason: 'load_failed' }
  if (!target || target.race_event_id !== eventId) return { ok: false, reason: 'not_found' }
  const members = Array.isArray(target.teams?.team_members) ? target.teams.team_members : []
  const contactId = person?.contact_id || null
  let member = contactId ? members.find((m) => m.contact_id && m.contact_id === contactId) : null
  const email = String(person?.email ?? '').trim().toLowerCase()
  if (!member && email) member = members.find((m) => String(m.email ?? '').trim().toLowerCase() === email)
  if (!member) return { ok: false, reason: 'not_on_team' }
  return { ok: true, registrationId: target.id, member }
}

/** Is this registration a placed solo whose check-in must be redirected? */
export function isPlacedRedirect(reg) {
  return reg?.status === 'placed' && !!reg?.placed_into_registration_id
}
