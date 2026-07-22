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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeInternalPath(searchParams.get('next'))

  const failTo = (reason) => NextResponse.redirect(new URL(`/login?error=${reason}`, origin))

  if (!code) return failTo('link_invalid')

  try {
    // createAuthClient() is the cookie-bound SSR client; in a route handler its
    // setAll writes the freshly-minted session cookies onto the response.
    const supabase = await createAuthClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (error || !data?.session) {
      logError('auth', 'magic-link code exchange failed', { err: error })
      return failTo('link_expired')
    }
  } catch (err) {
    logError('auth', 'magic-link code exchange threw', { err })
    return failTo('link_invalid')
  }

  return NextResponse.redirect(new URL(next, origin))
}
