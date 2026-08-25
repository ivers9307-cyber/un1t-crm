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
//     and we log it — recreating it is an operator step (see the WARNING
//     below before doing so).
//   - RUNTIME not-staff assertion before anything is minted (REPSET-PUB.3A-b).
//   - GoTrue internals never reach the client; failures log server-side only.
//
// ⚠️ OPERATOR WARNING — RECREATING THE DEMO USER RE-MINTS STAFF ⚠️
//
// "The demo account is member-only" is a property of DATA, not of code, and
// nothing holds it in place. The mig-404 trigger `on_auth_user_created` →
// handle_new_user() is LIVE on auth.users INSERT and mints a profiles row +
// profile_locations row with role 'staff' unless the new user's
// raw_user_meta_data carries a `contact_id` / `host_id` marker or an
// `invited_for` that is neither empty nor 'staff'. The demo user's metadata
// today is {full_name, email_verified} — none of those markers — so a plain
// admin.createUser() recreate lands squarely in the auto-mint branch. Mig
// 404's own closing comment flagged this as a tracked follow-up and it was
// never done; the escalation has ALREADY happened in prod once (changelog
// 423: the demo account held a profiles row + profile_locations role 'staff',
// so a session minted by this public route carried CRM staff access, and the
// rows had to be deleted by hand).
//
// So: recreate the demo user ONLY with the customer marker in its metadata —
// `{ contact_id: '<the demo contacts row id>' }` (or `invited_for` set to
// something other than 'staff') — which steers handle_new_user() away from
// the staff branch. The assertion below exists because that step is easy to
// forget: rather than trust the data, the route re-checks it on every request
// and refuses loudly instead of handing out a staff session.
//
// Registered as public in src/proxy.js `publicPaths` (it is called BEFORE the
// reviewer has a session — minting one is its whole job — so gating it would
// 401 every attempt) and in scripts/check-route-guards.mjs EXEMPT with that
// reason. It self-guards: only the exact demo email + configured code pass.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getClientIp } from '@/lib/rate-limit'
import { logWarn, logError } from '@/lib/log'
import { escapeLikePattern } from '@/lib/like-escape'
import { REVIEW_DEMO_EMAIL, readReviewCode, credentialsMatch } from '@/lib/review-login'

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
  // getClientIp (src/lib/rate-limit.js) is THE house reader: first
  // x-forwarded-for hop, then x-real-ip, then the shared 'unknown' bucket —
  // which is a real bucket, not a bypass. Reused rather than reimplemented so
  // this route's notion of "who is calling" can't drift from every other
  // rate-limited endpoint's.
  const ip = getClientIp(request)
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

  // ── RUNTIME not-staff assertion (REPSET-PUB.3A-b) ──────────────────────
  //
  // Turns the member-only property from DATA into an INVARIANT this route
  // enforces on every request. See the operator warning in the header: the
  // mig-404 auto-mint trigger re-grants staff to a recreated demo user, and
  // this route's own error path is what tells an operator to recreate it.
  //
  // Keyed on EMAIL, not on the auth user id, precisely because the scenario
  // being defended against is delete-and-recreate — which changes the id.
  // handle_new_user() writes profiles.email from new.email, so the email is
  // both what survives a recreate and what identifies the escalated row.
  //
  // Placed AFTER the credential check so a stranger cannot use this route to
  // probe whether the demo account currently holds staff rows, and BEFORE
  // generateLink so an escalated account never gets a session minted at all.
  //
  // .ilike (not .eq) because profiles.email is stored as GoTrue wrote it and
  // case is not guaranteed — but .ilike takes a LIKE PATTERN, so the constant
  // goes through escapeLikePattern(). It has no `_`/`%` today, which is
  // exactly why an unescaped version would have sat here looking correct
  // until someone changed the address (CLAUDE.md's .ilike invariant).
  let staffRows
  try {
    const { data, error } = await db
      .from('profiles')
      .select('id, role')
      .ilike('email', escapeLikePattern(REVIEW_DEMO_EMAIL))
    if (error) throw new Error(error.message || 'profiles read failed')
    staffRows = data || []
  } catch (err) {
    // FAIL CLOSED. An unreadable invariant is not a satisfied one — refusing
    // costs the reviewer a retry; assuming costs a staff session.
    logError('review-login', 'not-staff assertion could not be evaluated', {
      code: 'demo_account_staff_check_failed',
      err: err?.message || String(err),
    })
    return NextResponse.json({ success: false, error: 'Could not generate login' }, { status: 500 })
  }
  if (staffRows.length > 0) {
    // ANY row, whatever the role — the demo account must hold no profile at
    // all. Structured so an alert can match `code` rather than grep prose.
    logError('review-login', 'demo account holds a staff profile — refusing to mint a session', {
      code: 'demo_account_has_staff_profile',
      email: REVIEW_DEMO_EMAIL,
      profileCount: staffRows.length,
      profileIds: staffRows.map((r) => r.id),
      roles: staffRows.map((r) => r.role),
      remedy: 'delete the profiles row(s) (profile_locations cascades), then recreate the auth user only with a contact_id metadata marker — see mig 404 / changelog 423',
    })
    return NextResponse.json({ success: false, error: 'Could not generate login' }, { status: 500 })
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
