// POST /api/mobile/review-login — the App Store reviewer login gate.
//
// REPSET-PUB.3A. Ported from champ-app's hardened July 2026 route
// (REVIEW-LOGIN-HARDEN.1) for the merged "Repset Fitness" binary. The merged
// app's ONLY auth entry is the staff login via an 8-digit emailed OTP, which
// an Apple reviewer cannot receive — without this route review stalls at the
// login screen and the submission is rejected under Guideline 2.1.
//
// What it does: the reviewer enters the demo email + the gate code; we mint a
// real one-time email token server-side (service role) and hand it back for
// the client to verify into a session. Any other email, or a wrong code, is
// rejected. The demo account is member-only (auth user + contacts row, NO
// profiles / profile_locations rows), so the session this mints resolves
// `not_staff` at the identity spine (mobile/lib/identity.js) and lands on the
// member side with access to nothing but the reviewer's own seeded data.
//
// Hardening — every line of it is load-bearing, do not weaken:
//   - REVIEW_LOGIN_CODE with NO source fallback. Unset ⇒ 404, i.e. the route
//     is DORMANT by default. It stays unset until Richard sets a fresh code at
//     submission time, so the window in which this endpoint does anything at
//     all is measured in days.
//   - Per-IP throttle via review_login_rate_ok() (mig 449) runs BEFORE the
//     credential check, so guessing is throttled whatever email is supplied.
//     Fails CLOSED: an RPC error is 503, not "allow". Serverless instances
//     don't share memory, which is why the counter lives in the DB.
//   - Constant-time, length-blind comparison (src/lib/review-login.js).
//   - It can only ever sign in an account an OPERATOR created. champ's route
//     called auth.admin.createUser() idempotently first; that is deliberately
//     NOT ported. Supabase signups are OFF and load-bearing (mig 404), and a
//     public endpoint that can provision an auth user is a bigger surface
//     than one that can't. If the demo user is missing, generateLink fails
//     and we log it — recreating it is an operator step.
//   - GoTrue internals never reach the client; failures log server-side only.
//
// Registered as public in src/proxy.js `publicPaths` (it is called BEFORE the
// reviewer has a session — minting one is its whole job — so gating it would
// 401 every attempt) and in scripts/check-route-guards.mjs EXEMPT with that
// reason. It self-guards: only the exact demo email + configured code pass.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import {
  REVIEW_DEMO_EMAIL,
  readReviewCode,
  clientIpFromForwardedFor,
  credentialsMatch,
} from '@/lib/review-login'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  // Route OFF unless the gate code is explicitly configured. Checked FIRST so
  // a dormant deploy does no DB work at all and is indistinguishable from a
  // route that was never deployed.
  const configuredCode = readReviewCode()
  if (!configuredCode) {
    return NextResponse.json({ success: false, error: 'Not available' }, { status: 404 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const db = createServerClient()

  // Per-IP rate limit — brute-force protection on a public, unauthenticated
  // route. Counts EVERY attempt (it runs before the credential check), so the
  // limiter cannot be side-stepped by varying the email.
  //
  // The builder is a thenable, not a Promise (CLAUDE.md): `.catch()` on it
  // throws and the rpc never runs, so the guard is try/catch.
  const ip = clientIpFromForwardedFor(request.headers.get('x-forwarded-for'))
  let allowed
  try {
    const { data, error } = await db.rpc('review_login_rate_ok', { p_ip: ip })
    if (error) throw new Error(error.message || 'rpc error')
    allowed = data
  } catch (err) {
    // FAIL CLOSED. An unreadable limiter must not become an unthrottled
    // endpoint. 503 (not 500) says "try again shortly" — the reviewer's next
    // tap is the retry, and nothing is lost by refusing this one.
    logWarn('review-login', 'rate-limit rpc failed', { err: err?.message || String(err) })
    return NextResponse.json({ success: false, error: 'Try again shortly' }, { status: 503 })
  }
  if (allowed === false) {
    return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: 429 })
  }

  // Only the exact demo email + the exact configured code get through.
  if (!credentialsMatch({ configuredCode, email: body?.email, code: body?.code })) {
    return NextResponse.json({ success: false, error: 'Invalid code' }, { status: 403 })
  }

  // Mint a one-time email OTP for the client to verify into a session. This
  // does NOT send an email — admin.generateLink returns the token to us.
  const { data, error } = await db.auth.admin.generateLink({
    type: 'magiclink',
    email: REVIEW_DEMO_EMAIL,
  })
  const otp = data?.properties?.email_otp
  if (error || !otp) {
    // Never return GoTrue internals to the client. The overwhelmingly likely
    // cause of a failure here is the demo auth user having been deleted —
    // recreating it is an operator step, not something this route may do.
    logWarn('review-login', 'generateLink failed', {
      err: error?.message || 'no email_otp in response',
    })
    return NextResponse.json({ success: false, error: 'Could not generate login' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { otp } })
}
