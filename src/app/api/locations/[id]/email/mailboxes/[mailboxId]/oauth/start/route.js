// MAILBOX-OAUTH.3 — start a mailbox sign-in.
//
// GET /api/locations/[id]/email/mailboxes/[mailboxId]/oauth/start?provider=microsoft
//   → 302 to the provider's consent screen.
//
// The other half is /api/email/oauth/callback, which is a STATIC path for the
// reason spelled out there and in oauth-providers.js: a redirect URI has to be
// registered byte-for-byte on the app registration, and one carrying
// `/locations/<id>/mailboxes/<mailboxId>/` could never be.
//
// ── THE GATE IS THE SAME ONE THE PASSWORD ROUTE USES ──────────────────────
// guardMailboxAdmin — master or owner-at-location. Not the `email_inbox`
// permission: A MANAGER HOLDS THAT AND IS NOT ELEVATED, so gating on it would
// let a manager bind a Microsoft account to `accounts@` and, in doing so, hand
// themselves the studio's billing correspondence. Whoever may grant access to
// a mailbox is exactly whoever may connect one. Identical reasoning, identical
// guard, and deliberately the identical call so a future change to one gate
// changes both.
//
// 🔴 AND THIS ROUTE IS A REDIRECT, WHICH MAKES IT A GET THAT CHANGES NOTHING
// AND STILL HAS TO BE GUARDED. It writes no row. What it hands out is a signed
// state naming a location and a mailbox, and that value is the thing the
// callback trusts — so an unguarded start route would be a mint for
// capabilities against any mailbox id somebody could guess. It is gated before
// it signs anything, and the mailbox is resolved through loadMailboxOr404 (404,
// never 403) so ids stay unenumerable.
//
// ── WHAT IT REFUSES, AND WHY EACH REFUSAL IS BEFORE THE REDIRECT ──────────
// Everything checkable is checked HERE rather than in the callback. A refusal
// after consent means the operator has already signed in, already granted a
// third-party app access to their mail, and is then told it did not work — and
// the grant they just issued is left standing at the provider with nothing on
// our side referring to it. Refusing first costs a page load; refusing last
// costs a live grant nobody is tracking.

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getAppUrl } from '@/lib/app-url'
import { logError } from '@/lib/log'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { isConfigured } from '@/lib/mail/secret-box'
import {
  resolveOAuthProvider, buildAuthorizeUrl, callbackUrl, signState,
  STATE_COOKIE, STATE_TTL_MS,
} from '@/lib/mail/oauth-providers'
import { OAUTH_ENCRYPTION_MESSAGE } from '@/lib/mail/oauth-tokens'
import {
  guardMailboxAdmin, mailboxUnauthorized, loadMailboxOr404,
  MAX_CONNECTED_MAILBOXES_PER_LOCATION,
} from '../../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'email-mailbox-oauth-start'

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

// A consent redirect is cheaper than a live IMAP dial, but it is not free: it
// signs a capability and it sends somebody to a third party. The same
// 20-in-15-minutes budget the connect route spends on live logins, keyed per
// CALLER for the same reason — the action is identity-bound, and one owner
// tidying a settings form must not contend with another studio's.
const START_RATE = { max: 20, windowMs: 15 * 60_000 }

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const url = new URL(request.url)
  const providerKey = url.searchParams.get('provider') || ''

  // Resolved BEFORE the database is touched: an unknown or unavailable
  // provider is a fixed answer that needs no row, and Google's refusal in
  // particular is a sentence an operator should be able to read without any
  // part of the estate having done work for it.
  const provider = resolveOAuthProvider(providerKey)
  if (!provider.ok) {
    // 400 for "we will not", 503 for "we cannot yet" — the second is ours to
    // fix and should page somebody, the first never will be.
    const status = provider.reason === 'not_configured' ? 503 : 400
    if (provider.reason === 'not_configured') {
      logError(MODULE, 'a mailbox sign-in was requested for a provider this deployment has no client id for', {
        locationId: params.id, provider: providerKey,
      })
    }
    return bad(provider.error, status, { code: provider.reason })
  }

  // Never start a flow whose tokens we could not store. secret-box throws on a
  // missing key by design; asking first turns that into a sentence rather than
  // a 500 halfway through a callback, and it is asked BEFORE the operator is
  // sent to a provider rather than after they have granted access.
  if (!isConfigured()) {
    logError(MODULE, 'MAILBOX_SECRET_KEY is not configured', { locationId: params.id })
    return bad(OAUTH_ENCRYPTION_MESSAGE, 503, { code: 'not_configured' })
  }

  // CRON_SECRET signs the state (see oauth-providers.js for why it, and not
  // the mailbox encryption key). Without it there is no way to prove the round
  // trip started here, and a callback that cannot prove that must not run.
  const signingSecret = process.env.CRON_SECRET
  if (!signingSecret) {
    logError(MODULE, 'CRON_SECRET is not set — cannot sign an OAuth state', { locationId: params.id })
    return bad(
      'Mailbox sign-in is not available on this deployment yet — a required setting is missing. Nothing has been changed.',
      503,
      { code: 'not_configured' }
    )
  }

  let appUrl
  try {
    appUrl = getAppUrl()
  } catch {
    // getAppUrl throws rather than guessing an origin (no silent env
    // fallbacks). A guessed origin here would be a redirect_uri the provider
    // refuses, reported as a consent failure the operator cannot act on.
    logError(MODULE, 'NEXT_PUBLIC_APP_URL is not set — cannot build a redirect URI', { locationId: params.id })
    return bad(
      'Mailbox sign-in is not available on this deployment yet — a required setting is missing. Nothing has been changed.',
      503,
      { code: 'not_configured' }
    )
  }

  const db = createServerClient()
  const found = await loadMailboxOr404(db, params.id, params.mailboxId)
  if (found.response) return found.response
  const mailbox = found.mailbox

  // Same refusal, same words, same reason as the password route: a deactivated
  // account does not route inbound mail anywhere, so polling it would pull a
  // customer's mail OUT of their inbox and file it nowhere.
  if (!mailbox.active) {
    return bad(
      'This account is deactivated, so mail sent to it does not route anywhere. Reactivate it first, then connect the mailbox.',
      400
    )
  }

  // ── The connected-mailbox cap (Phase 11.1) ────────────────────────────
  // Counted here rather than in the callback for the reason at the top of the
  // file: an operator must not complete a consent flow and only then be told
  // their studio is at its limit. The exemption is the same one the password
  // route applies — a mailbox that is ALREADY connected is being re-signed-in,
  // which is maintenance, and a cap that blocks maintenance is worse than no
  // cap. Re-checking in the callback would reintroduce exactly that.
  if (mailbox.ingress !== 'imap') {
    const { count, error: countErr } = await db.from('email_mailboxes')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', params.id)
      .eq('ingress', 'imap')
    if (countErr) {
      // Fail OPEN, loudly — the estate's rule. The ceiling protects poll
      // fairness, which is a nicety; refusing a legitimate connection over a
      // transient read is a real cost to a real operator.
      logError(MODULE, 'could not count connected mailboxes — allowing the sign-in', {
        locationId: params.id, mailboxId: params.mailboxId, error: countErr.message,
      })
    } else if ((count ?? 0) >= MAX_CONNECTED_MAILBOXES_PER_LOCATION) {
      return bad(
        `This studio already has ${count} connected mailboxes, which is the limit. ` +
        'Disconnect one you no longer read before connecting another, or ask for the limit to be raised.',
        400,
        { code: 'connected_mailbox_limit' }
      )
    }
  }

  const budget = await checkRateLimit(db, `mailbox-oauth:${user.id}`, START_RATE)
  if (!budget.allowed) {
    return rateLimitResponse(
      budget,
      'Too many mailbox sign-in attempts in a row. Wait a few minutes and try again. Nothing has been changed.'
    )
  }

  // ── The state ─────────────────────────────────────────────────────────
  // Everything the callback needs and NOTHING the callback could get another
  // way. `profileId` is here so the callback can notice that the browser that
  // came back belongs to a different signed-in user than the one who started —
  // a session swapped mid-flow is not an attack we have a story for, but it is
  // a state where binding a mailbox on the second person's authority would be
  // silently wrong.
  //
  // The nonce is what makes two flows started for the same mailbox in the same
  // second distinguishable, so the cookie comparison below is a comparison of
  // THIS flow rather than of any flow.
  const state = signState({
    nonce: randomBytes(16).toString('hex'),
    locationId: params.id,
    mailboxId: params.mailboxId,
    provider: provider.config.key,
    profileId: user.id,
    ts: Date.now(),
  }, signingSecret)

  const authorizeUrl = buildAuthorizeUrl({
    config: provider.config,
    state,
    redirectUri: callbackUrl(appUrl),
    // Pre-fills the provider's account picker. NOT a security control — the
    // operator can sign in as anybody, which is why the callback proves the
    // identity that actually came back by dialling IMAP with it rather than by
    // trusting this. It is purely the difference between "which of my six
    // accounts was this for" and a one-click confirm.
    loginHint: mailbox.address || undefined,
  })

  const res = NextResponse.redirect(authorizeUrl)
  // 🔴 THE COOKIE IS THE SECOND OF THREE INDEPENDENT CHECKS, and it is the one
  // that survives a leaked signing key. httpOnly so script cannot read it,
  // sameSite lax so it still rides the provider's top-level GET redirect back
  // (strict would drop it and break every flow), and the same 10 minutes the
  // signature's own TTL allows so the two halves cannot disagree about whether
  // a flow is stale.
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: Math.floor(STATE_TTL_MS / 1000),
    path: '/',
  })
  return res
}
