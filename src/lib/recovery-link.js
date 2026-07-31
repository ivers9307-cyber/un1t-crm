// Recovery / invite link handshake — shared by /reset-password and
// /host/set-password.
//
// ──────────────────────────────────────────────────────────────────────
// RESET-PKCE.1 (prod bug, 2026-07-31). Both pages used to do:
//
//     await supabase.auth.signOut({ scope: 'local' })      // "clean slate"
//     await supabase.auth.exchangeCodeForSession(code)     // <- always failed
//
// auth-js `_removeSession()` (which `signOut` calls for any scope other
// than 'others', even with no session present) removes THREE storage keys:
// `${storageKey}`, `${storageKey}-user` and `${storageKey}-code-verifier`.
// That last one is the PKCE verifier the exchange on the next line needs,
// so the sign-out destroyed it and every `?code=` link — which is the shape
// Supabase issues, since @supabase/ssr pins `flowType: 'pkce'` — died with
// AuthPKCECodeVerifierMissingError. Re-clicking the (by then consumed) link
// then produced a GoTrue `#error=access_denied&error_code=otp_expired`
// bounce, which the old code read as "no token present" and reported as
// "this link is missing its verification token".
//
// The order is now: establish the session FIRST, sign out only on failure.
// That keeps the 2026-05-13 security property intact — a successful
// exchange/setSession/verifyOtp OVERWRITES stored session with the link
// user's, and any failure path signs out — so `updateUser()` can never
// target a different account that happened to be signed in already. The
// caller also gets back the confirmed user id to pin the update to.
// ──────────────────────────────────────────────────────────────────────

/** Error carrying an operator-readable message plus a stable code. */
export class RecoveryLinkError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RecoveryLinkError'
    this.code = code || 'link_invalid'
  }
}

/**
 * Parse every token shape Supabase may put on a recovery / invite link:
 *   PKCE query:    ?code=<one_time_code>
 *   token_hash:    ?token_hash=<hash>&type=recovery   (device-independent)
 *   implicit hash: #access_token=…&refresh_token=…&type=recovery
 *   failure:       #error=access_denied&error_code=otp_expired&…
 */
export function parseRecoveryLink({ hash = '', search = '' } = {}) {
  const hashParams = new URLSearchParams(String(hash || '').replace(/^#/, ''))
  const queryParams = new URLSearchParams(String(search || '').replace(/^\?/, ''))
  const pick = (key) => queryParams.get(key) || hashParams.get(key) || null

  const type = pick('type')
  return {
    // Falls back to 'recovery' framing — the safer default if detection
    // ever fails (someone resetting an existing password sees the right
    // wording; an invitee sees slightly off but functional wording).
    flowType: type === 'invite' ? 'invite' : 'recovery',
    code: pick('code'),
    tokenHash: pick('token_hash'),
    accessToken: hashParams.get('access_token'),
    refreshToken: hashParams.get('refresh_token'),
    errorCode: pick('error_code') || pick('error'),
    errorDescription: pick('error_description'),
  }
}

const freshLinkHint = (flowType) =>
  flowType === 'invite'
    ? 'Ask the person who invited you to send a fresh one.'
    : 'Request a fresh one from the login page.'

/** Map a GoTrue bounce or SDK error onto something a human can act on. */
function explain(code, flowType, fallback) {
  if (code === 'otp_expired' || code === 'access_denied') {
    return `This link has expired or has already been used. ${freshLinkHint(flowType)}`
  }
  if (code === 'pkce_code_verifier_not_found') {
    return 'This link has to be opened in the same browser you requested it from. '
      + 'If your email app opened it in its own browser, copy the link into your normal browser, '
      + `or request a fresh one there. ${freshLinkHint(flowType)}`
  }
  if (code === 'missing_token') {
    return `This link is missing its verification token. ${freshLinkHint(flowType)}`
  }
  return `Reset link could not be verified: ${fallback || 'unknown error'}. ${freshLinkHint(flowType)}`
}

/**
 * Turn a parsed link into a confirmed recovery session.
 *
 * Returns `{ userId }` for the account the link belongs to. Throws a
 * RecoveryLinkError (already worded for the operator) on any failure,
 * having signed the browser out so no stale session survives.
 */
export async function establishRecoverySession(supabase, link) {
  const { flowType } = link

  const bail = async (code, fallback) => {
    // Clean slate on the way out: a link that didn't verify must never
    // leave another account's session behind for updateUser() to hit.
    try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* ignore */ }
    throw new RecoveryLinkError(explain(code, flowType, fallback), code)
  }

  // GoTrue already told us it refused the link — don't spend a round trip.
  if (link.errorCode) await bail(link.errorCode, link.errorDescription)

  let result
  if (link.code) {
    result = await supabase.auth.exchangeCodeForSession(link.code)
  } else if (link.accessToken && link.refreshToken) {
    result = await supabase.auth.setSession({
      access_token: link.accessToken,
      refresh_token: link.refreshToken,
    })
  } else if (link.tokenHash) {
    result = await supabase.auth.verifyOtp({
      token_hash: link.tokenHash,
      type: flowType === 'invite' ? 'invite' : 'recovery',
    })
  } else {
    await bail('missing_token')
  }

  const err = result?.error
  if (err) await bail(err.code || err.name || 'link_invalid', err.message)

  const linkUserId = result?.data?.user?.id || null

  // Only report ready once the server confirms whose session we hold, and
  // that it is the link's user — not one that was already signed in here.
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  const sessionUserId = userData?.user?.id || null
  if (userErr || !sessionUserId) await bail('no_session', userErr?.message || 'no session was established')
  if (linkUserId && sessionUserId !== linkUserId) await bail('user_mismatch', 'session did not match the link')

  return { userId: sessionUserId }
}
