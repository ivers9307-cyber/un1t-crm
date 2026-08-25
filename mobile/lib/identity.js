// PHASE2 stage C — the identity spine's pure logic. The merged app holds
// ONE session that may be a staff profile, a member contact, or both;
// this module owns the tri-state probes and every transition rule. All
// side effects are dependency-injected so the rules stay unit-testable.
//
// The load-bearing safety property: a TRANSIENT failure (network blip,
// champ/CRM host outage, 5xx, timeout) must never demote an established
// mode. Only a 401 answered with a PROVEN-FRESH token may confirm
// 'not_staff' — a 401 on a stale token is indistinguishable from an
// expired session and resolves 'unknown' instead.
//
// The silent link-contact fallback (champ's app-first member self-link)
// is policy-gated here: it fires ONLY for a CONFIRMED not_staff session
// whose member probe came back CONFIRMED empty, on a device that has
// never held a staff session (has_ever_been_staff flag below). Staff
// linking is admin-only — locked decision.

import * as SecureStore from 'expo-secure-store'

// ── Staff probe states ──
export const STAFF = 'staff'
export const NOT_STAFF = 'not_staff'
export const UNKNOWN = 'unknown'

// ── Member probe states ──
export const MEMBER = 'member'
export const NO_MEMBER = 'no_member'

// ── Shell entry routes ──
export const STAFF_HOME = '/(staff)/(tabs)'
export const MEMBER_HOME = '/(member)/(tabs)/home'
export const NOT_SET_UP_ROUTE = '/account-not-set-up'

/**
 * Probe the staff identity via GET /api/mobile/me.
 *
 * @param {object} deps
 * @param {() => Promise<{status:number, json:any}>} deps.fetchMe
 *   Performs the /me request with the CURRENT access token; throws on
 *   network failure/timeout.
 * @param {() => Promise<boolean>} deps.refreshSession
 *   Attempts a token refresh on the shared client; resolves true only on
 *   a confirmed successful refresh.
 * @param {boolean} [deps.justRefreshed]
 *   True when the caller KNOWS the request will ride a token from a
 *   just-successful refresh (e.g. a TOKEN_REFRESHED re-probe) — a 401 is
 *   then immediately conclusive.
 * @returns {Promise<{state: 'staff'|'not_staff'|'unknown', payload?: any}>}
 */
export async function probeStaff({ fetchMe, refreshSession, justRefreshed = false }) {
  let res
  try {
    res = await fetchMe()
  } catch {
    return { state: UNKNOWN }
  }
  if (res.status === 200) return { state: STAFF, payload: res.json }
  if (res.status !== 401) return { state: UNKNOWN } // 5xx / 403 / anything else: inconclusive

  // 401. Conclusive only on a proven-fresh token.
  if (justRefreshed) return { state: NOT_STAFF }

  let refreshed = false
  try {
    refreshed = await refreshSession()
  } catch {
    refreshed = false
  }
  // Refresh failed → we never held a provably-fresh token; the session may
  // simply be dead (the auth listener owns that). Inconclusive.
  if (!refreshed) return { state: UNKNOWN }

  let retry
  try {
    retry = await fetchMe()
  } catch {
    return { state: UNKNOWN }
  }
  if (retry.status === 200) return { state: STAFF, payload: retry.json }
  if (retry.status === 401) return { state: NOT_STAFF } // fresh token, still 401 → confirmed
  return { state: UNKNOWN }
}

/**
 * Probe the member identity: a contacts row linked to this user_id, read
 * via the shared client (RLS-scoped select).
 *
 * @param {object} deps
 * @param {() => Promise<{data:any, error:any}>} deps.fetchContact
 * @returns {Promise<{state: 'member'|'no_member'|'unknown', contact?: any}>}
 */
export async function probeMember({ fetchContact }) {
  try {
    const { data, error } = await fetchContact()
    if (error) return { state: UNKNOWN }
    return data ? { state: MEMBER, contact: data } : { state: NO_MEMBER }
  } catch {
    return { state: UNKNOWN }
  }
}

/**
 * Fold a re-probe result (TOKEN_REFRESHED etc.) into the current staff
 * state. Upgrades are allowed; an ACTIVE mode is never downgraded —
 * mid-session revocation is next-boot's problem, not a mid-use rug-pull.
 */
export function applyReprobe(current, probed) {
  if (probed === STAFF) return STAFF
  if (current === STAFF) return STAFF // never demote an active staff mode
  if (probed === NOT_STAFF) return current === UNKNOWN ? NOT_STAFF : current
  return current // 'unknown' never changes anything
}

/**
 * The silent link-contact policy (see module header). All three legs must
 * be CONFIRMED — any 'unknown' leg means no self-link this launch.
 */
export function shouldAttemptLinkContact({ staffState, hasEverBeenStaff, memberState }) {
  return staffState === NOT_STAFF && !hasEverBeenStaff && memberState === NO_MEMBER
}

/**
 * The boot resolver's routing matrix (design point 3).
 *
 *   kiosk pairing      → staff shell ONLY (member mode suppressed entirely)
 *   impersonating      → staff shell (member mode suppressed)
 *   staff-only         → staff tabs
 *   member-only        → member home
 *   dual               → last-used side (first-time default: staff)
 *   confirmed neither  → account-not-set-up
 *   inconclusive       → last side if set, else confirmed member, else
 *                        staff (today's pre-merge default — the staff
 *                        shell owns its own error states)
 */
export function resolveEntryRoute({ paired, impersonating, staffState, memberState, lastSide }) {
  if (paired) return STAFF_HOME
  if (impersonating) return STAFF_HOME
  const isStaff = staffState === STAFF
  const isMember = memberState === MEMBER
  if (isStaff && isMember) return lastSide === 'member' ? MEMBER_HOME : STAFF_HOME
  if (isStaff) return STAFF_HOME
  if (staffState === NOT_STAFF) {
    if (isMember) return MEMBER_HOME
    if (memberState === NO_MEMBER) return NOT_SET_UP_ROUTE
    return MEMBER_HOME // not staff + member probe inconclusive → degrade member-side
  }
  // Staff state inconclusive (offline boot, CRM outage).
  if (lastSide === 'member' || lastSide === 'staff') {
    return lastSide === 'member' ? MEMBER_HOME : STAFF_HOME
  }
  if (isMember) return MEMBER_HOME // the only confirmed identity wins
  return STAFF_HOME
}

// ── Device-scoped identity history (SecureStore) ───────────────────────

// Set the moment a staff probe ever succeeds on this device+session.
// While set, the member-side link-contact fallback is HARD-DISABLED.
// CLEARED on sign-out: a different user may sign in next, so the flag is
// per-session, not per-device-forever.
const HAS_EVER_BEEN_STAFF_KEY = 'repset_has_ever_been_staff'

// The member contact id last confirmed on this device — read by the
// sign-out teardown to delete that contact's per-contact Apple-Health
// SecureStore keys without needing a live contact context.
const MEMBER_CONTACT_ID_KEY = 'repset_member_contact_id'

export async function getHasEverBeenStaff() {
  try {
    return (await SecureStore.getItemAsync(HAS_EVER_BEEN_STAFF_KEY)) === '1'
  } catch {
    // Unreadable ⇒ treat as unset: the fallback stays gated on the other
    // two CONFIRMED legs either way.
    return false
  }
}

export async function setHasEverBeenStaff() {
  try {
    await SecureStore.setItemAsync(HAS_EVER_BEEN_STAFF_KEY, '1')
  } catch { /* best-effort */ }
}

export async function clearHasEverBeenStaff() {
  try {
    await SecureStore.deleteItemAsync(HAS_EVER_BEEN_STAFF_KEY)
  } catch { /* best-effort */ }
}

export async function readCachedMemberContactId() {
  try {
    return (await SecureStore.getItemAsync(MEMBER_CONTACT_ID_KEY)) || null
  } catch {
    return null
  }
}

export async function writeCachedMemberContactId(contactId) {
  if (!contactId) return
  try {
    await SecureStore.setItemAsync(MEMBER_CONTACT_ID_KEY, String(contactId))
  } catch { /* best-effort */ }
}

export async function clearCachedMemberContactId() {
  try {
    await SecureStore.deleteItemAsync(MEMBER_CONTACT_ID_KEY)
  } catch { /* best-effort */ }
}
