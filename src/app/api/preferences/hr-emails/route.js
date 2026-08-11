// GET /api/preferences/hr-emails
//
// Public one-click "stop these emails" link for the post-class heart-rate
// summary. Flips contacts.hr_post_class_emails_enabled to false and renders a
// confirmation page.
//
// ─── WHAT WAS WRONG (HRPREF-AUTH.1) ────────────────────────────────────────
// It took `?cid=<contact_id>` and nothing else. No token, no rate limit. The
// route's own header comment defended that as an accepted trade-off, on the
// grounds that the worst an adversary could do was silence a stranger's HR
// emails, and that the sibling /api/preferences and /api/unsubscribe routes
// made the same trade.
//
// Both halves of that were wrong.
//
//   • The siblings do NOT make that trade. They authenticate with
//     `contact_preferences.unsubscribe_token`, a v4 UUID minted per contact by
//     mig 005. A contact id is an IDENTIFIER, not a credential: it is a
//     database primary key that appears in admin URLs, CSV exports, log lines,
//     Sentry breadcrumbs and support threads. Its unguessability is incidental,
//     not a security property, and nothing about the system treats it as a
//     secret.
//   • "Only flips a flag to less mail" understates it. The GET also READ the
//     contact row and told the caller, by which page it rendered, whether that
//     person was already unsubscribed. Given a list of contact ids that is an
//     oracle over a preference. And the write itself is a consent record being
//     changed by somebody who is not the data subject.
//
// ─── WHAT IT TAKES NOW ─────────────────────────────────────────────────────
// Two accepted credentials. Both are capabilities; neither is a bare id.
//
//   1. `?token=<contact_preferences.unsubscribe_token>` — CANONICAL. Same
//      credential, same guard, same refusal logging as /api/preferences/[token]
//      and /api/unsubscribe/[token]. Every HR email sent from now on carries
//      this and nothing else.
//
//   2. `?cid=<contact_id>&sid=<heart_rate_session_id>` — LEGACY, kept working.
//      This is not a grudging compatibility shim: at the time of writing there
//      are thousands of already-delivered HR emails sitting in real inboxes
//      whose only unsubscribe link is this pair, and breaking them would mean
//      breaking the opt-out for exactly the people trying to use it. That is a
//      worse outcome than the hole.
//
//      The pair is accepted only when the session RESOLVES and BELONGS to the
//      named contact. That is what turns it back into a capability: knowing
//      somebody's contact id tells you nothing whatsoever about their session
//      ids, so the pair cannot be assembled from a leaked id alone. Every
//      already-delivered link carries both halves (the composer has always
//      emitted `cid` and `sid` together), so this closes the hole for the
//      legacy population TOO rather than merely grandfathering it open.
//
// A bare `cid` is refused. That is the fix.
//
// ─── SUNSET ────────────────────────────────────────────────────────────────
// The legacy pair can be deleted once the last HR email predating this change
// has aged out of inboxes. It is one boolean below, and every use of it is
// logged under 'hr-pref-legacy-link' so the decay is measurable before anyone
// makes that call. Do not delete it on a guess.
//
// Public path — already in middleware.publicPaths via /api/preferences/.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getClientIp } from '@/lib/rate-limit'
import { logInfo, logWarn } from '@/lib/log'
import {
  REFUSAL_REASONS,
  guardBeforeTokenLookup,
  penaliseInvalidToken,
  guardResolvedToken,
  recordRefusedOptOut,
} from '@/lib/consent-token-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Rate-limit + refusal-log namespace. Deliberately its OWN scope rather than
 * reusing 'preferences': HR-email traffic and preference-centre traffic must
 * not be able to exhaust each other's per-IP enumeration budget.
 */
const SCOPE = 'hr-emails'

/**
 * Accept the pre-HRPREF-AUTH.1 `cid`+`sid` links that are already in people's
 * inboxes. Flip to false only once those have aged out; see SUNSET above.
 */
const ACCEPT_LEGACY_CID_SID = true

/**
 * Both credentials are UUIDs (`contact_preferences.unsubscribe_token` and
 * `heart_rate_sessions.id`), so anything that is not one cannot resolve and is
 * rejected without a query. Same shape gate as /api/preferences/[token].
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request) {
  const url = new URL(request.url)
  const token = (url.searchParams.get('token') || '').trim()
  const contactId = (url.searchParams.get('cid') || '').trim()
  const sessionId = (url.searchParams.get('sid') || '').trim()
  const scope = (url.searchParams.get('scope') || 'hr').trim()

  if (scope !== 'hr') {
    return htmlResponse('<h1>Unknown scope</h1>', 400)
  }
  if (!token && !contactId) {
    // No credential at all. Costs no database work, so there is nothing to
    // budget against; this is the mangled-forwarded-link case, not an attack.
    return htmlResponse(
      `<h1>Invalid link</h1><p>This unsubscribe link is incomplete. Reply to any of our emails and we will sort it out.</p>`,
      400
    )
  }

  const db = createServerClient()
  const ip = getClientIp(request)
  const userAgent = request.headers.get('user-agent') || null

  // The credential presented, whichever form it took. Used for the per-token
  // budget key and the audit fingerprint, so neither ever stores a live one.
  const credential = token || `${contactId}:${sessionId}`

  const refusal = (reason, extra = {}) => recordRefusedOptOut(db, {
    endpoint: SCOPE, reason, ip, token: credential, userAgent, ...extra,
  })
  const notFound = () => htmlResponse(
    `<h1>Link not recognised</h1><p>This unsubscribe link may have expired. Reply to any of our emails and we will take you off the list.</p>`,
    404
  )

  // ── shape gate, before any query ──────────────────────────────────
  const shapeOk = token
    ? UUID_RE.test(token)
    // A contact id on its own is no longer a credential, so the missing `sid`
    // is a refusal here rather than a separate branch below.
    : (ACCEPT_LEGACY_CID_SID && UUID_RE.test(contactId) && UUID_RE.test(sessionId))

  if (!shapeOk) {
    await penaliseInvalidToken(db, SCOPE, ip)
    await refusal(REFUSAL_REASONS.INVALID_TOKEN)
    return notFound()
  }

  // ── per-IP enumeration budget, PEEKED not spent ───────────────────
  // We do not yet know whether this caller holds a real capability, and
  // charging a legitimate holder is the defect UNSUB-RL.1 exists to prevent.
  const ipBudget = await guardBeforeTokenLookup(db, SCOPE, ip)
  if (!ipBudget.allowed) {
    await refusal(REFUSAL_REASONS.IP_ENUMERATION)
    return tooManyRequests(ipBudget)
  }

  // ── resolve the credential to exactly one contact ─────────────────
  let resolvedContactId = null

  if (token) {
    const { data: pref } = await db
      .from('contact_preferences')
      .select('contact_id')
      .eq('unsubscribe_token', token)
      .maybeSingle()
    resolvedContactId = pref?.contact_id || null
  } else {
    // Legacy pair. The session is the second factor: it must exist AND name
    // the same contact the link claims.
    const { data: session } = await db
      .from('heart_rate_sessions')
      .select('id, contact_id')
      .eq('id', sessionId)
      .maybeSingle()
    if (session && session.contact_id === contactId) {
      resolvedContactId = contactId
      logInfo('hr-pref-legacy-link', 'legacy cid+sid link used', { contactId })
    }
  }

  if (!resolvedContactId) {
    await penaliseInvalidToken(db, SCOPE, ip)
    await refusal(REFUSAL_REASONS.INVALID_TOKEN)
    return notFound()
  }

  // ── per-credential budget ─────────────────────────────────────────
  // Keyed on the credential fingerprint ALONE, no IP component: a mail
  // provider's shared egress proxy must never be able to trip this for
  // everybody behind it. Only a client looping on one link reaches it.
  const credBudget = await guardResolvedToken(db, SCOPE, credential)
  if (!credBudget.allowed) {
    await refusal(REFUSAL_REASONS.TOKEN_FLOOD, { contactId: resolvedContactId })
    return tooManyRequests(credBudget)
  }

  // ── the actual opt-out ────────────────────────────────────────────
  const { data: contact } = await db
    .from('contacts')
    .select('id, hr_post_class_emails_enabled')
    .eq('id', resolvedContactId)
    .maybeSingle()

  if (!contact) {
    // The credential resolved but the contact is gone (merged or deleted).
    // Nothing to switch off, and saying so plainly beats a 500.
    return alreadyDonePage()
  }

  // Already off is a no-op SUCCESS, not an error: mail clients and link
  // scanners re-fetch these URLs, and the second fetch must not look broken.
  if (contact.hr_post_class_emails_enabled !== false) {
    const { error: updErr } = await db
      .from('contacts')
      .update({ hr_post_class_emails_enabled: false })
      .eq('id', resolvedContactId)
    if (updErr) {
      logWarn('hr-pref', 'failed to update flag', { contactId: resolvedContactId, err: updErr })
      return htmlResponse(
        `<h1>Couldn't update preferences</h1><p>Please try again shortly, or reply to any of our emails and we will do it for you.</p>`,
        500
      )
    }
    logInfo('hr-pref', 'unsubscribed from hr emails', { contactId: resolvedContactId })
  }

  return alreadyDonePage()
}

function alreadyDonePage() {
  return htmlResponse(`
    <h1>You're unsubscribed</h1>
    <p>You won't get post-class heart-rate summary emails any more.</p>
    <p style="margin-top:24px;font-size:13px;color:#666;">
      Changed your mind? You can re-enable these in your app account
      → Settings, or just reply to any email and we'll flip it back.
    </p>
  `)
}

/**
 * A human clicked this from their inbox, so a refusal is a page, not a JSON
 * body. Retry-After still goes on the response for the automated callers
 * (link scanners) that produce most of this traffic.
 */
function tooManyRequests(budget) {
  const res = htmlResponse(`
    <h1>Too many requests</h1>
    <p>We have had a lot of hits on this link just now. Please try again in a few minutes.</p>
  `, 429)
  res.headers.set('Retry-After', String(budget.retryAfterSec))
  return res
}

function htmlResponse(bodyHtml, status = 200) {
  const html = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Email preferences · UN1T</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { margin:0; padding:48px 24px; font-family: ui-sans-serif, system-ui, sans-serif;
           background:#f4f4f5; color:#111; }
    .card { max-width:480px; margin:0 auto; background:#fff; padding:32px;
            border-radius:12px; border:1px solid #e5e7eb; }
    h1 { margin:0 0 12px 0; font-size:22px; }
    p  { margin:8px 0; line-height:1.5; color:#444; }
  </style>
</head><body>
  <div class="card">${bodyHtml}</div>
</body></html>`
  return new NextResponse(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
