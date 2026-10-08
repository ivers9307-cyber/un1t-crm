// registration-move — move an event ENTRY (one race_registrations row: its
// people, its payment, its history) to another event. EVENT-MOVE.1.
//
// The unit is the entry, never the team: today every entry is a team (a solo
// is a team of one), and team-less single bookings are coming. Nothing here
// may assume `teams` is set.
//
// Split: the RULES are pure functions in this file (unit-tested with plain
// objects); the WRITES are one Postgres function, move_race_registration
// (mig 708), so a half-applied move cannot exist. Money is never touched: a
// price gap is computed, recorded and shown, nothing more.
//
// Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md

export const MOVE_ERRORS = Object.freeze({
  NOT_FOUND: 'not_found',
  NOT_ACTIVE: 'not_active',
  CHECKED_IN: 'checked_in',
  SAME_EVENT: 'same_event',
  TARGET_UNAVAILABLE: 'target_unavailable',
  DIFFERENT_PAYEE: 'different_payee',
  ALREADY_ENTERED: 'already_entered',
  HEADCOUNT_NOT_ALLOWED: 'headcount_not_allowed',
  WAVE_REQUIRED: 'wave_required',
  WRONG_EVENT: 'wrong_event',
  WAVE_FULL: 'wave_full',
})

// Plain-English for the dialog. Keyed by code so the route never invents copy.
export const MOVE_ERROR_MESSAGES = Object.freeze({
  not_found: 'That entry no longer exists.',
  not_active: 'Only a confirmed entry or one awaiting payment can be moved.',
  checked_in: 'Someone on this entry has already checked in, so it cannot move.',
  same_event: 'That is the event the entry is already on. Use the wave select to change its time.',
  target_unavailable: 'The target event is not published or has already happened.',
  different_payee: 'The target event is paid to a different host, so the payment cannot follow.',
  already_entered: 'This team already has an entry on the target event.',
  headcount_not_allowed: 'The target event does not accept an entry of this size.',
  wave_required: 'Pick a time on the target event.',
  wrong_event: 'That time does not belong to the target event.',
  wave_full: 'That time is full.',
})

/** The team row's live roster, if loaded. Never assumes a team. */
function membersOf(registration) {
  const list = registration?.teams?.team_members
  return Array.isArray(list) ? list : []
}

/**
 * What the UI calls an entry: the team name for a team of two or more, else
 * the person (captain, lead contact), else "Entry".
 */
export function entryLabel(registration) {
  const team = registration?.teams || null
  const members = membersOf(registration)
  if (team?.name && (members.length > 1 || (members.length === 0 && Number(team.size) > 1))) return team.name
  const captain = members.find((m) => m?.role === 'captain') || members[0]
  if (captain?.name) return captain.name
  const c = registration?.contact
  const contactName = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim()
  if (contactName) return contactName
  if (team?.name) return team.name
  return 'Entry'
}

/** People on the entry: the loaded roster, else teams.size, else 1. */
export function entryHeadcount(registration) {
  const members = membersOf(registration)
  if (members.length > 0) return members.length
  const size = Number(registration?.teams?.size)
  return Number.isFinite(size) && size > 0 ? size : 1
}

/** Per-person ticket price on an event for a member / non-member, in cents. */
export function perPersonFeeCents(event, isMember) {
  const nonMember = Number(event?.non_member_fee_cents) || 0
  if (!event?.member_pricing_enabled) return nonMember
  return isMember ? (Number(event?.member_fee_cents) || 0) : nonMember
}

/**
 * (target per-person − source per-person) summed over the people on the
 * entry. Signed; 0 when prices match. A roster of zero (team-less entry)
 * counts as one non-member.
 */
export function computePriceGapCents({ sourceEvent, targetEvent, members }) {
  const roster = Array.isArray(members) && members.length > 0 ? members : [{ is_member: false }]
  let gap = 0
  for (const m of roster) {
    const isMember = m?.is_member === true
    gap += perPersonFeeCents(targetEvent, isMember) - perPersonFeeCents(sourceEvent, isMember)
  }
  return gap
}
