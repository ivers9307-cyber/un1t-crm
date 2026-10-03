// src/lib/staff-login-access.js
// ACTIVEUSER.1 — the LOGIN side of deactivating / reactivating a staff member.
//
// "Deactivate" used to write profiles.active=false and nothing else, while its
// own audit comment claimed it revoked access to the platform. It did not: the
// Supabase auth user was untouched. There are now TWO locks, and they are not
// equals:
//
//   1. getCurrentUser() (and getWidgetUser()) refuse a profile whose `active`
//      is false. That is THE lock for the app: every /api route and every
//      server page goes through it, it cannot fail, and it needs nothing from
//      this file.
//   2. The ban here. It closes what lock 1 cannot see: the BROWSER's and the
//      phone's direct, RLS-bound Supabase client. RLS reads profiles.role LIVE
//      and NEVER reads `active`: private.auth_is_in_location(),
//      private.auth_role() and private.auth_is_master() (and the inline
//      `p.role = 'master'` policies) answer exactly as they did before the
//      deactivation. So what the ban buys depends on whether there IS one:
//        • BANNED login (staff-only): the refresh stops, so direct access
//          lasts at most the access token's remaining lifetime (the
//          project's JWT expiry, one hour by default).
//        • KEPT login (also a member's / host's, or the ban failed, or we
//          could not check): the JWT keeps refreshing INDEFINITELY, and a
//          hand-made PostgREST call with it still reads the studio data RLS
//          grants that role. The CRM, the staff app's /api calls and widgets
//          are blocked (lock 1); the data layer is not.
//      FOLLOW-UP, NOT IN THIS PR: a forward-only migration adding
//      `active IS NOT FALSE` to those three helpers (and the inline master
//      policies), which closes the kept-login case at the database. Until it
//      lands, the kept_* warnings below must not claim access is fully off.
//
// Because lock 1 already holds, the two directions fail DIFFERENTLY — this is
// "removing a silent failure must never create a louder one" applied:
//
//   • a failed BAN must not fail or undo the deactivation. It is logged
//     structurally and returned as a `warning`; deactivating again (DELETE, or
//     any save that sends active:false) retries it.
//   • a failed UNBAN leaves a reactivated person who cannot sign in, and nothing
//     else will ever tell the operator. It is returned as an `error` the route
//     surfaces, and saving the (now active) profile again retries it: the retry
//     reads the ban state first, so an ordinary save of an active profile never
//     writes to the login.
//
// WHO IS NOT BANNED. The same rule permanent delete uses (authDisposition): a
// login that is ALSO a gym member's or an event host's is left alone, and so is
// one we could not check — a wrong ban locks a paying member out of their app,
// while the staff side is dead either way (lock 1).
//
// KNOWN GAP (review S6, a PRODUCT question, no code here): an ex-staff member
// whose login was BANNED at deactivation and who later joins as a gym member
// with the same email cannot sign in to the member app — the ban predates the
// contact link, and nothing re-evaluates it. Operator workaround: reactivate
// them (lifts the ban), link the contact to the login, then deactivate again —
// the login is now also a member's, so this time it is kept.
//
// WHAT A DEACTIVATION NEVER DOES: scramble the email, reset the password or
// clear metadata. Those are the tombstone's, and they are irreversible; a
// deactivation must be undone by one click. Callers must never pass a
// tombstone (both staff routes 404 one first): its ban is permanent.

import { authDisposition, AUTH_BAN_DURATION } from './staff-tombstone.js'
import { logError } from './log.js'

/** GoTrue's spelling of "lift the ban". */
export const LOGIN_UNBAN = 'none'

// (review S2) These say what IS blocked and that the login still works — never
// "access is off", which is not true of a kept login (see lock 2 above).
const KEPT_WARNINGS = {
  kept_member_login: 'The CRM, the staff app and home screen widgets are blocked for them. The login itself was left working because it is also a gym member login, so their member app still works.',
  kept_host_login: 'The CRM, the staff app and home screen widgets are blocked for them. The login itself was left working because it is also an event host login, so their host portal still works.',
  kept_unverified: 'The CRM, the staff app and home screen widgets are blocked for them. The login itself was left working because we could not check whether it is also a member or host login. Save their profile again to retry.',
}

/** Is this login ALSO a member or a host? Pure reads. Shared with permanent delete. */
export async function readLoginDisposition(db, id) {
  const [contactRes, hostRes] = await Promise.all([
    db.from('contacts').select('id').eq('user_id', id).limit(1).maybeSingle(),
    db.from('host_users').select('host_id').eq('auth_user_id', id).limit(1).maybeSingle(),
  ])
  return authDisposition({
    memberContact: contactRes.data, hostUser: hostRes.data, readFailed: !!(contactRes.error || hostRes.error),
  })
}

/** Pure. GoTrue reports a ban as a `banned_until` instant on the user. */
export function isBanned(authUser, now = Date.now()) {
  const until = Date.parse(authUser?.banned_until || '')
  return Number.isFinite(until) && until > now
}

// auth.admin.* answers { error } for an API refusal but can also THROW (a
// dropped socket). Both are the same fact to a caller here.
async function adminUpdate(db, id, patch) {
  try {
    const { error } = await db.auth.admin.updateUserById(id, patch)
    return error || null
  } catch (err) {
    return err || new Error('auth admin call failed')
  }
}

/**
 * DEACTIVATE: end the person's sessions by banning a staff-only login. Call it
 * AFTER the profiles write succeeded — never before, or a refused deactivation
 * (mig 080's last-active-master trigger) would leave a banned, active master.
 * Idempotent, and never throws.
 *
 * @returns {Promise<{ outcome: 'banned'|'ban_failed'|'kept_member_login'|'kept_host_login'|'kept_unverified', ok: boolean, warning: string|null }>}
 */
export async function suspendStaffLogin(db, id) {
  let disposition
  try {
    disposition = await readLoginDisposition(db, id)
  } catch (err) {
    logError('staff-login-access', 'could not read login disposition on deactivate', { profileId: id, err })
    disposition = 'kept_unverified'
  }
  if (disposition !== 'ban') return { outcome: disposition, ok: true, warning: KEPT_WARNINGS[disposition] }

  const err = await adminUpdate(db, id, { ban_duration: AUTH_BAN_DURATION })
  if (!err) return { outcome: 'banned', ok: true, warning: null }

  logError('staff-login-access', 'ban failed on deactivate: profile is inactive, login still enabled', { profileId: id, err })
  return {
    outcome: 'ban_failed',
    ok: false,
    warning: `The CRM, the staff app and home screen widgets are blocked for them, but disabling their login failed: ${err.message || err}. Save their profile again to retry, or ban the user in the Supabase dashboard (Authentication, Users).`,
  }
}

/**
 * REACTIVATE: lift the ban so the person can sign in again. `transition` is
 * true when this request flipped active false→true: the unban is then sent
 * unconditionally. Otherwise (an already-active profile being saved) this is
 * the RETRY for an unban that failed earlier, and it only writes when the login
 * really is still banned. Never throws.
 *
 * @returns {Promise<{ outcome: 'restored'|'restore_failed'|'not_banned'|'unknown', ok: boolean, error: string|null }>}
 */
export async function restoreStaffLogin(db, id, { transition, now = Date.now() } = {}) {
  if (!transition) {
    let authUser = null
    let readErr = null
    try {
      const { data, error } = await db.auth.admin.getUserById(id)
      authUser = data?.user || null
      readErr = error || (authUser ? null : new Error('no auth user returned'))
    } catch (err) {
      readErr = err
    }
    if (readErr) {
      // An ordinary save of an active profile must not fail because the auth
      // admin API blinked. If an unban IS still owed, the operator was told
      // when it failed, and the next save asks again.
      logError('staff-login-access', 'could not read ban state for an active profile', { profileId: id, err: readErr })
      return { outcome: 'unknown', ok: true, error: null }
    }
    if (!isBanned(authUser, now)) return { outcome: 'not_banned', ok: true, error: null }
  }

  const err = await adminUpdate(db, id, { ban_duration: LOGIN_UNBAN })
  if (!err) return { outcome: 'restored', ok: true, error: null }

  logError('staff-login-access', 'unban failed on reactivate: profile is active, login still banned', { profileId: id, err })
  return {
    outcome: 'restore_failed',
    ok: false,
    error: `They are reactivated, but re-enabling their login failed, so they cannot sign in yet: ${err.message || err}. Press Reactivate or save their profile again to retry, or lift the ban in the Supabase dashboard (Authentication, Users).`,
  }
}
