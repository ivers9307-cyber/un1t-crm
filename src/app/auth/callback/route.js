// GET /auth/callback — completes a passwordless (magic-link) sign-in on web.
//
// MAGIC-LINK.1. The staff login form calls supabase.auth.signInWithOtp with
// emailRedirectTo=<origin>/auth/callback; the emailed link (the SHARED Supabase
// Magic Link template's {{ .ConfirmationURL }}, also used by the Pulse app) hits
// here with a PKCE `?code=`. We exchange it for a session — createAuthClient()
// (SSR, cookie-bound) writes the session cookies onto the response, so the
// browser lands authenticated.
//
// Deliberately mirrors champ-app/src/app/auth/callback so BOTH apps share the
// one Supabase template unchanged (they route to different /auth/callback via
// their own emailRedirectTo). PKCE also binds the link to the browser that
// requested it — no cross-device login-CSRF, unlike a bare token_hash flow.
// Staff need no contact-linking (that's Pulse-customer-only), so this is the
// lean exchange-and-redirect variant. Failures return a coarse error code.

import { NextResponse } from 'next/server'
import { createAuthClient } from '@/lib/auth'
import { safeInternalPath } from '@/lib/urlish'
import { logError } from '@/lib/log'
import { isBannedSignInError } from '@/lib/login-account-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeInternalPath(searchParams.get('next'))

  const failTo = (reason) => NextResponse.redirect(new URL(`/login?error=${reason}`, origin))

  // ACTIVEUSER.1 (review S1) — GoTrue answers a link it will not honour with an
  // ERROR bounce (`?error=…&error_code=…`, no `code`), and this route used to
  // read every one of them as "no code → link_invalid". Two are worth telling
  // apart, because the person can ACT on them:
  //   user_banned  deactivation bans the login. "That link was not valid,
  //                request a fresh one" sends them round that loop forever;
  //                /login?error=account_deactivated says what happened.
  //                Checked BEFORE the code, and with no exchange attempted.
  //   otp_expired  an expired link is not a malformed one (CLAUDE.md).
  // Only the QUERY is visible here: a bounce GoTrue puts in the #fragment never
  // reaches a server route, and still lands on link_invalid below.
  const errorCode = searchParams.get('error_code')
  if (errorCode === 'user_banned') return failTo('account_deactivated')
  if (!code && errorCode === 'otp_expired') return failTo('link_expired')

  if (!code) return failTo('link_invalid')

  try {
    // createAuthClient() is the cookie-bound SSR client; in a route handler its
    // setAll writes the freshly-minted session cookies onto the response.
    const supabase = await createAuthClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (error || !data?.session) {
      logError('auth', 'magic-link code exchange failed', { err: error })
      // A ban discovered at the exchange itself is the same fact.
      if (isBannedSignInError(error)) return failTo('account_deactivated')
      return failTo('link_expired')
    }
  } catch (err) {
    logError('auth', 'magic-link code exchange threw', { err })
    return failTo('link_invalid')
  }

  return NextResponse.redirect(new URL(next, origin))
}
