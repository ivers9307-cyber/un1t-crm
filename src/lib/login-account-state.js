// src/lib/login-account-state.js
// ACTIVEUSER.1 — client-safe helpers for the /login page's "your session is
// valid but your account is switched off" handling. No server imports.

// Operator's rule: no em-dashes in user-facing copy. Calm, and says what to do.
export const DEACTIVATED_MESSAGE = 'This account has been deactivated. Ask an owner to reactivate it.'

/**
 * Deactivation bans a staff-only login, so GoTrue answers a password sign-in
 * with `user_banned` / "User is banned". A TOMBSTONE is banned too, but its
 * email is scrambled to deleted+<id>@deleted.invalid, so nobody can type the
 * address that reaches it: on this form, banned means deactivated.
 */
export function isBannedSignInError(error) {
  if (!error) return false
  return error.code === 'user_banned' || /\bbanned\b/i.test(error.message || '')
}

/**
 * Ask GET /api/auth/account-state about the CURRENT session. Resolves the
 * state string, or 'unknown' on ANY failure (offline, a proxy 307 to the login
 * HTML, a non-JSON body): the login page only acts on 'deactivated', so a
 * failure here can never sign anyone out or block a sign-in.
 */
export async function fetchAccountState(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('/api/auth/account-state', { cache: 'no-store' })
    const body = await res.json()
    return body?.success && typeof body.data?.state === 'string' ? body.data.state : 'unknown'
  } catch {
    return 'unknown'
  }
}
