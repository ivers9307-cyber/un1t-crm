// registration-entry — the BROWSER-SAFE half of the event-entry move
// (EVENT-MOVE.1). Pure helpers and constants only: what an entry is called,
// how many people it holds, the per-person fee and the price gap of a move,
// and the refusal codes with their plain-English copy.
//
// Why a separate file: registration-move.js loads rows and runs the move, so
// it imports server modules (host-contact-list reaches contact-tags,
// sequences/triggers and @/lib/supabase's service-role client). A client
// component (MoveEntryDialog) that imported entryLabel from there would ship
// that whole server chain to the browser. This file imports NOTHING, and
// must stay that way: anything touching Supabase, Postmark or the server
// belongs in registration-move.js, which re-exports everything below so
// server code and tests keep importing from one place.
//
// The unit is the entry, never the team: nothing here may assume `teams` is
// set. Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md

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
  LOAD_FAILED: 'load_failed',
  WRITE_FAILED: 'write_failed',
  CONFLICT: 'conflict',
})

// Plain-English for the dialog. Keyed by code so the route never invents copy.
export const MOVE_ERROR_MESSAGES = Object.freeze({
  not_found: 'That entry no longer exists.',
  not_active: 'Only a confirmed entry or one awaiting payment can be moved.',
  checked_in: 'Someone on this entry has already checked in or raced, so it cannot move.',
  same_event: 'That is the event the entry is already on. Use the wave select to change its time.',
  target_unavailable: 'The target event is not published or has already happened.',
  different_payee: 'The target event is paid to a different host, so the payment cannot follow.',
  already_entered: 'This team already has an entry on the target event (a cancelled one counts).',
  headcount_not_allowed: 'The target event does not accept an entry of this size.',
  wave_required: 'Pick a time on the target event.',
  wrong_event: 'That time does not belong to the target event.',
  wave_full: 'That time is full.',
  load_failed: 'The entry could not be read. Try again.',
  write_failed: 'The move could not be saved. Nothing changed. Try again.',
  conflict: 'This entry changed while you were moving it. Reload and try again.',
})

/**
 * The team row's live roster, if loaded. Never assumes a team. Exported for
 * registration-move.js only; registration-move does not re-export it.
 */
export function membersOf(registration) {
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
 * entry. Signed; 0 when prices match. With no roster loaded (a team-less
 * entry, or a team whose member rows are missing) it prices `headcount`
 * non-members, so the gap covers the same people as the move's headcount.
 */
export function computePriceGapCents({ sourceEvent, targetEvent, members, headcount = 1 }) {
  const n = Number.isFinite(Number(headcount)) && Number(headcount) > 0 ? Math.floor(Number(headcount)) : 1
  const roster = Array.isArray(members) && members.length > 0
    ? members
    : Array.from({ length: n }, () => ({ is_member: false }))
  let gap = 0
  for (const m of roster) {
    const isMember = m?.is_member === true
    gap += perPersonFeeCents(targetEvent, isMember) - perPersonFeeCents(sourceEvent, isMember)
  }
  return gap
}
