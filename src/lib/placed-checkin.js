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
//
// FINDTEAM.9: a placed row whose target is gone (placed_into_registration_id
// is null: the FK is ON DELETE SET NULL, mig 766) is still a placed row, so it
// is redirected too, and the redirect refuses (`target_gone`, which the routes
// answer with their "not on this registration" shape). Before this the null
// pointer read as "not a redirect" and the dead solo row was checked in.

/**
 * @param {object} db  service-role client
 * @param {{ eventId: string, placedIntoId: string, person: { contact_id?: string|null, email?: string|null } }} args
 * @returns {Promise<{ ok: true, registrationId: string, member: { id: string, name?: string|null, email?: string|null, contact_id?: string|null } }
 *   | { ok: false, reason: 'load_failed'|'not_found'|'not_on_team'|'target_gone' }>}
 */
export async function followPlacementForCheckin(db, { eventId, placedIntoId, person }) {
  if (!placedIntoId) return { ok: false, reason: 'target_gone' }
  const { data: target, error } = await db
    .from('race_registrations')
    .select('id, race_event_id, status, teams ( id, team_members ( id, name, email, contact_id ) )')
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
  return { ok: true, registrationId: target.id, member, registrationStatus: target.status ?? null }
}

/**
 * Is this registration a placed solo whose check-in must be redirected? Every
 * placed row is: one with no target left is redirected into a refusal
 * (followPlacementForCheckin → target_gone), never checked in on itself.
 */
export function isPlacedRedirect(reg) {
  return reg?.status === 'placed'
}

// CHECKINSTATUS.1 (audit 2026-11-15, item 11): a QR or a tap checked in any
// registration it found, including a CANCELLED one (the scan selected status
// and never looked at it) or one never paid for. Only these statuses may be
// checked in: confirmed, and no_show (staff may mark one before the person
// turns up late). Judged on the registration the check-in lands on, i.e.
// the team entry for a placed solo.
const CHECKIN_ALLOWED = new Set(['confirmed', 'no_show'])

/** @returns {string|null} why this registration cannot be checked in, or null */
export function checkinStatusRefusal(status) {
  if (CHECKIN_ALLOWED.has(status)) return null
  if (status === 'cancelled') return 'This entry was cancelled, so it cannot be checked in.'
  if (status === 'pending_payment') return 'This entry has not been paid for, so it cannot be checked in.'
  return 'This entry cannot be checked in.'
}

/** True when a race_checkins insert failed only because the person is already in. */
export function isAlreadyCheckedIn(error) {
  return !!error && /duplicate|unique|23505/i.test(error.message || '')
}
