import * as SecureStore from 'expo-secure-store'

// "Seen recap" flag, keyed per session id, so the post-class "wrapped" ceremony
// auto-presents ONCE per session and never re-ambushes the member on a revisit.
// Mirrors mobile/lib/profile-setup-dismissal.js (best-effort SecureStore, never
// throws). SecureStore keys must match [A-Za-z0-9._-]; session ids are UUIDs so
// they're already safe, but we sanitise defensively.

const PREFIX = 'recap_seen_'

function keyFor(sessionId) {
  return PREFIX + String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '')
}

/** Has the member already seen the recap ceremony for this session? */
export async function hasSeenRecap(sessionId) {
  if (!sessionId) return true // no id → never auto-present
  try {
    return (await SecureStore.getItemAsync(keyFor(sessionId))) != null
  } catch {
    // On a storage error, fail "seen" so we don't risk repeatedly popping the
    // full-screen ceremony over a member who can't be marked done.
    return true
  }
}

/** Mark this session's recap as seen (idempotent, best-effort). */
export async function markRecapSeen(sessionId) {
  if (!sessionId) return
  try { await SecureStore.setItemAsync(keyFor(sessionId), String(Date.now())) } catch { /* best-effort */ }
}

/** Clear the flag (used by the manual "View recap" affordance to force a replay). */
export async function clearRecapSeen(sessionId) {
  if (!sessionId) return
  try { await SecureStore.deleteItemAsync(keyFor(sessionId)) } catch { /* best-effort */ }
}

// ── Monthly "wrapped" recap (Wave 5) ──────────────────────────────
// Mirrors the per-session flag above but keyed by the recapped month
// ('YYYY-MM'), so the month-end story auto-presents ONCE per month and never
// re-ambushes the member on subsequent home visits that same month.

const MONTH_PREFIX = 'month_recap_seen_'

function monthKeyFor(monthKey) {
  return MONTH_PREFIX + String(monthKey || '').replace(/[^A-Za-z0-9._-]/g, '')
}

/** Has the member already seen the monthly recap for this 'YYYY-MM'? */
export async function hasSeenMonthRecap(monthKey) {
  if (!monthKey) return true // no key → never auto-present
  try {
    return (await SecureStore.getItemAsync(monthKeyFor(monthKey))) != null
  } catch {
    // Fail "seen" on a storage error so we never repeatedly pop the ceremony.
    return true
  }
}

/** Mark this month's recap as seen (idempotent, best-effort). */
export async function markMonthRecapSeen(monthKey) {
  if (!monthKey) return
  try { await SecureStore.setItemAsync(monthKeyFor(monthKey), String(Date.now())) } catch { /* best-effort */ }
}
