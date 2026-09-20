// src/lib/staff-tombstone.js
// STAFFDELETE.1 — a permanently deleted staff member is a TOMBSTONE, not a
// missing row.
//
// profiles.id → auth.users is ON DELETE CASCADE (mig 004:36) and ~25 tables
// cascade off profiles (shift_assignments, time_off_requests,
// staff_allowances, contractor_invoices, …), so deleting the row — or the
// auth user — destroys the history the business must keep. Instead the row
// stays with `deleted_at` set (mig 622), PII stripped and `full_name` kept, so
// every past shift, leave request, invoice and report still names the person.
//
// TWO THINGS THE FUNCTION DECIDES (mig 622), both so the promise holds:
//   • ROLE. RLS reads profiles.role LIVE (private.auth_is_master(),
//     private.auth_role(), and dozens of inline `p.role = 'master'` policies),
//     so a tombstone that kept role='master' would stay a master at the RLS
//     layer for any login we could not ban. The function copies the role to
//     `deleted_role` and sets `role` to the floor ('staff'). Role HISTORY is
//     roleAtDeletion(), never `role`.
//   • "UPCOMING" means NOT STARTED. A shift that has started today (Dublin
//     wall clock) is history and stays; the summary lists those separately as
//     kept_today_shifts.
//
// THE RULE FOR READERS: a tombstone is always active=false (DB CHECK), has no
// profile_locations and no tokens. So `.eq('active', true)` readers and
// location-scoped lists exclude it structurally. Any read that lists profiles
// WITHOUT an id / active / email filter must go through excludeTombstones();
// any code that ACTS on one profile by id must refuse isTombstone().
// tests/staff-tombstone-readers.test.js fails CI on a new unfiltered list.

export const TOMBSTONE_EMAIL_DOMAIN = 'deleted.invalid'
export const AUTH_BAN_DURATION = '876000h' // 100 years
// The least-privileged staff role. profiles.role has no CHECK (mig 004:39), so
// the floor is the column's own DEFAULT — which is also the lowest rung of
// every role CHECK that does exist (profile_locations mig 051:46,
// location_role_permissions mig 364:31). Mirrors the literal in mig 622.
export const TOMBSTONE_FLOOR_ROLE = 'staff'

/** Pure. Deactivated (active=false) is NOT deleted; only deleted_at is. */
export function isTombstone(profile) {
  return !!profile?.deleted_at
}

/** Role HISTORY for a profile: what they were when deleted, else what they are. */
export function roleAtDeletion(profile) {
  return profile?.deleted_role ?? profile?.role ?? null
}

/** Narrow a `profiles` query to rows that are not tombstones. Returns the builder. */
export function excludeTombstones(query) {
  return query.is('deleted_at', null)
}

/** The address a tombstone (and its banned auth user) carries. `.invalid` is reserved: it can never receive mail. */
export function tombstoneEmail(profileId) {
  return `deleted+${String(profileId).toLowerCase()}@${TOMBSTONE_EMAIL_DOMAIN}`
}

/**
 * What to do with the auth user. It can never be DELETED (the cascade above).
 * It is banned unless the same login is also a member or a host — and when we
 * cannot tell, it is kept: the staff side is dead either way (getCurrentUser
 * refuses a tombstone), while a wrong ban locks a paying member out.
 */
export function authDisposition({ memberContact, hostUser, readFailed }) {
  if (readFailed) return 'kept_unverified'
  if (memberContact) return 'kept_member_login'
  if (hostUser) return 'kept_host_login'
  return 'ban'
}

const ERROR_MAP = [
  ['staff_not_found', 404, 'Profile not found'],
  ['staff_still_active', 400, 'Profile must be deactivated first. Soft-archive (set Active off) before permanent delete.'],
  ['staff_self_delete', 400, 'You cannot permanently delete your own account.'],
]

/**
 * tombstone_staff_profile raises P0001 with a `staff_*:` prefix (mig 622). An
 * existing tombstone is NOT an error: the function answers already_tombstoned.
 */
export function tombstoneErrorStatus(message) {
  const msg = String(message || '')
  const hit = ERROR_MAP.find(([prefix]) => msg.startsWith(prefix))
  return hit ? { status: hit[1], error: hit[2] } : { status: 500, error: `Permanent delete failed: ${msg}` }
}

/** One "shifts need cover" notice per studio — published shifts only (a draft is nobody's plan yet). */
export function coverNoticesByLocation(removedShifts) {
  const by = new Map()
  for (const s of removedShifts || []) {
    if (s?.roster_status !== 'published' || !s.location_id) continue
    const cur = by.get(s.location_id) || { locationId: s.location_id, count: 0, firstDate: s.block_date }
    cur.count += 1
    if (s.block_date < cur.firstDate) cur.firstDate = s.block_date
    by.set(s.location_id, cur)
  }
  return [...by.values()]
}

/** The other person on each cancelled swap. */
export function swapCounterparties(cancelledSwaps, profileId) {
  return (cancelledSwaps || [])
    .map((s) => ({ swapId: s.id, notifyId: s.requester_id === profileId ? s.target_id : s.requester_id }))
    .filter((x) => x.notifyId && x.notifyId !== profileId)
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** The confirmation dialog's copy, from a dry-run (or real) summary. */
export function describeTombstoneImpact(summary) {
  const shifts = (summary?.removed_shifts || []).length
  const swaps = (summary?.cancelled_swaps || []).length
  const leave = (summary?.cancelled_time_off || []).length
  const removes = [
    shifts > 0
      ? `Removed from ${plural(shifts, 'upcoming shift', 'upcoming shifts')}. These will need cover.`
      : 'They are on no upcoming shifts.',
  ]
  if (swaps > 0) removes.push(`${plural(swaps, 'open swap request', 'open swap requests')} cancelled.`)
  if (leave > 0) removes.push(`${plural(leave, 'pending leave request', 'pending leave requests')} cancelled.`)
  const k = summary?.kept || {}
  const kept = [
    k.past_shifts > 0 && plural(k.past_shifts, 'past shift', 'past shifts'),
    k.time_off_requests > 0 && plural(k.time_off_requests, 'leave request', 'leave requests'),
    k.contractor_invoices > 0 && plural(k.contractor_invoices, 'invoice', 'invoices'),
  ].filter(Boolean)
  const keptRows = summary?.kept_today_shifts || []
  const arrived = keptRows.filter((x) => x?.reason === 'arrived').length
  const started = keptRows.length - arrived
  const keptLines = [
    started > 0 && `Today's shifts already started: kept (${plural(started, 'shift', 'shifts')}).`,
    // An arrival is matched up to 45 min before the start: a shift they have
    // turned up for is history even though the clock says "not started".
    arrived > 0 && `Already arrived for ${plural(arrived, 'upcoming shift', 'upcoming shifts')}: kept.`,
  ].filter(Boolean)
  const role = summary?.role
  return {
    removes,
    // Today's shifts that have already started are HISTORY, not "upcoming".
    keptToday: keptLines.length > 0 ? keptLines.join(' ') : undefined,
    demotion: role?.from && role.from !== role.to
      ? `Their ${role.from} role is removed (the account is reduced to basic ${role.to} so it keeps no admin rights). The record still shows their role was ${role.from}.`
      : undefined,
    keeps: `Kept, under their name: ${[...kept, 'their allowance and pay records', 'and every report'].join(', ')}.`,
  }
}

const KEPT_LOGIN = {
  kept_member_login: 'Their login is kept because they are also a gym member; staff access is removed.',
  kept_host_login: 'Their login is kept because they are also an event host; staff access is removed.',
  kept_unverified: 'We could not check whether their login is also a member or host account, so it is kept for now; staff access is removed.',
}

/**
 * What happens to the person's LOGIN, in plain words. The delete does NOT
 * always remove it: the same account may also be a gym member or an event
 * host, and that login is deliberately kept (authDisposition). `done` = after
 * the delete ran; `completed` = the login step reached its final outcome.
 * An unknown disposition claims nothing about the login.
 */
export function describeAuthOutcome(disposition, { done = false, completed = false } = {}) {
  if (KEPT_LOGIN[disposition]) return KEPT_LOGIN[disposition]
  if (disposition !== 'ban') return 'Staff access is removed.'
  if (!done) return 'Their login will be disabled.'
  return completed ? 'Their login has been disabled.' : 'Their login has NOT been disabled yet; staff access is removed.'
}

/** The login step did not reach a final outcome: DELETE again re-runs only that step. */
export function needsAuthRetry(result) {
  if (!result) return false
  return result.auth_completed === false && (result.auth === 'ban' || result.auth === 'kept_unverified')
}

/** Lines for the "done" notice, from a DELETE response's `data`. A retry removed nothing, so it says only that. */
export function describeDeleteResult(result) {
  const login = describeAuthOutcome(result?.auth, { done: true, completed: result?.auth_completed === true })
  if (result?.already_deleted) {
    return [result.changed === false ? 'They were already permanently deleted. Nothing was changed.' : 'They were already permanently deleted.', login]
  }
  const d = describeTombstoneImpact(result)
  return [...d.removes, d.keptToday, d.demotion, login, d.keeps].filter(Boolean)
}
