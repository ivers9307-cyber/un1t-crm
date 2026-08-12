// /api/preferences/hr-emails
//
// Public "stop these emails" link for the post-class heart-rate summary.
// GET renders a confirmation page; POST flips
// contacts.hr_post_class_emails_enabled to false.
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
// ─── WHY GET NO LONGER WRITES (GETMUT.1) ───────────────────────────────────
// The opt-out used to happen in the GET. So did it: a mail-provider link
// scanner, a corporate security appliance or a browser prefetch that merely
// FOLLOWED the URL unsubscribed the person without them ever clicking. The
// credential does not help — the scanner is holding the link, in the mail it
// is scanning. This route's own comment already recorded that scanners
// re-fetch these URLs; it read that as an idempotency problem ("the second
// fetch must not look broken") when it was also the CAUSE.
//
// So the shape is now /api/unsubscribe/[token]'s: GET navigates, POST acts.
// GET resolves and budgets the credential exactly as before and then renders a
// one-button confirmation form that POSTs back to the same URL. The human
// confirms; a scanner following a link does not.
//
// TWO THINGS THE CONFIRM PAGE MUST KEEP DOING:
//   • It must not be an ORACLE. The pre-GETMUT.1 GET returned the same page
//     whether or not the person was already unsubscribed, which is the
//     property that stopped a holder of many links from reading preferences
//     off the responses. The confirm page preserves it the strongest way
//     available: GET does not read `contacts` at all, so its body cannot vary
//     with the flag, or with whether the contact row still exists.
//   • It must keep the abuse accounting. `penaliseInvalidToken` /
//     `recordRefusedOptOut` run on BOTH methods. Those are SECURITY
//     accounting, not consent — writing them on a GET is fine and necessary,
//     since the enumeration they price happens on the GET. What GETMUT.1
//     forbids is mutating the person's CONSENT on a GET.
//
// One-click provider semantics are NOT affected: this URL appears only in the
// visible body of the HR email (hr-post-class-email.js), never in an RFC 8058
// List-Unsubscribe / List-Unsubscribe-Post header — the HR send goes through
// sendTransactionalEmail, which passes no `unsubscribeUrl` and rides the
// 'outbound' stream, and sendEmail attaches those headers only for
// `broadcast` + an explicit URL. So no mail provider one-click-POSTs here and
// there is nothing for a confirmation page to break. If that ever changes, the
// header must point at a URL whose POST acts with no confirmation — this one
// already does.
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

/**
 * GETMUT.1 — the shared front half of both handlers: scope check, shape gate,
 * per-IP peek, credential resolution, per-credential budget, refusal logging.
 * Returns either `{ refused: Response }` or `{ db, contactId, credentialQuery }`.
 *
 * ONE copy on purpose, the way resolveTokenOrRefuse is shared by GET and PUT in
 * /api/preferences/[token]. Two handlers means two chances for the guards to
 * drift, and the one that drifts is the one nobody re-reads.
 */
async function resolveCredentialOrRefuse(request) {
  const url = new URL(request.url)
  const token = (url.searchParams.get('token') || '').trim()
  const contactId = (url.searchParams.get('cid') || '').trim()
  const sessionId = (url.searchParams.get('sid') || '').trim()
  const scope = (url.searchParams.get('scope') || 'hr').trim()

  if (scope !== 'hr') {
    return { refused: htmlResponse('<h1>Unknown scope</h1>', 400) }
  }
  if (!token && !contactId) {
    // No credential at all. Costs no database work, so there is nothing to
    // budget against; this is the mangled-forwarded-link case, not an attack.
    return {
      refused: htmlResponse(
        `<h1>Invalid link</h1><p>This unsubscribe link is incomplete. Reply to any of our emails and we will sort it out.</p>`,
        400
      ),
    }
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
    return { refused: notFound() }
  }

  // ── per-IP enumeration budget, PEEKED not spent ───────────────────
  // We do not yet know whether this caller holds a real capability, and
  // charging a legitimate holder is the defect UNSUB-RL.1 exists to prevent.
  const ipBudget = await guardBeforeTokenLookup(db, SCOPE, ip)
  if (!ipBudget.allowed) {
    await refusal(REFUSAL_REASONS.IP_ENUMERATION)
    return { refused: tooManyRequests(ipBudget) }
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
    return { refused: notFound() }
  }

  // ── per-credential budget ─────────────────────────────────────────
  // Keyed on the credential fingerprint ALONE, no IP component: a mail
  // provider's shared egress proxy must never be able to trip this for
  // everybody behind it. Only a client looping on one link reaches it.
  const credBudget = await guardResolvedToken(db, SCOPE, credential)
  if (!credBudget.allowed) {
    await refusal(REFUSAL_REASONS.TOKEN_FLOOD, { contactId: resolvedContactId })
    return { refused: tooManyRequests(credBudget) }
  }

  // The confirm form has to POST back with whatever credential the link
  // carried, so a legacy inbox link keeps working end to end. Rebuilt from the
  // parsed values rather than echoing the raw query string: every value here
  // has passed UUID_RE above, so nothing caller-controlled reaches the HTML.
  const credentialQuery = token
    ? new URLSearchParams({ scope: 'hr', token }).toString()
    : new URLSearchParams({ scope: 'hr', cid: contactId, sid: sessionId }).toString()

  return { db, contactId: resolvedContactId, credentialQuery }
}

// GET /api/preferences/hr-emails — CONFIRM ONLY. Writes no consent; see
// GETMUT.1 in the header. Everything before the render is identical to POST's
// front half, including the refusal accounting.
export async function GET(request) {
  const gate = await resolveCredentialOrRefuse(request)
  if (gate.refused) return gate.refused
  return confirmPage(gate.credentialQuery)
}

// POST /api/preferences/hr-emails — this is what actually opts the person out.
export async function POST(request) {
  const gate = await resolveCredentialOrRefuse(request)
  if (gate.refused) return gate.refused
  const { db, contactId } = gate

  const { data: contact } = await db
    .from('contacts')
    .select('id, hr_post_class_emails_enabled')
    .eq('id', contactId)
    .maybeSingle()

  if (!contact) {
    // The credential resolved but the contact is gone (merged or deleted).
    // Nothing to switch off, and saying so plainly beats a 500.
    return alreadyDonePage()
  }

  // Already off is a no-op SUCCESS, not an error: people click the link in two
  // different emails, and a browser re-POSTs on refresh. The second attempt
  // must not look broken.
  if (contact.hr_post_class_emails_enabled !== false) {
    const { error: updErr } = await db
      .from('contacts')
      .update({ hr_post_class_emails_enabled: false })
      .eq('id', contactId)
    if (updErr) {
      logWarn('hr-pref', 'failed to update flag', { contactId, err: updErr })
      return htmlResponse(
        `<h1>Couldn't update preferences</h1><p>Please try again shortly, or reply to any of our emails and we will do it for you.</p>`,
        500
      )
    }
    logInfo('hr-pref', 'unsubscribed from hr emails', { contactId })
  }

  return alreadyDonePage()
}

/**
 * GETMUT.1 — the page a valid link now lands on.
 *
 * NOT AN ORACLE: it is built from the credential alone. The handler above
 * never reads `contacts`, so this body is byte-identical for a contact who is
 * already unsubscribed, one who is still opted in, and one whose row no longer
 * exists — which is what stops somebody holding many links from reading
 * preferences off the responses. Do not add a "you're already unsubscribed"
 * branch here; that is the oracle, rebuilt.
 */
function confirmPage(credentialQuery) {
  return htmlResponse(`
    <h1>Stop these emails?</h1>
    <p>Confirm and we'll stop sending you post-class heart-rate summary emails.</p>
    <form method="post" action="?${credentialQuery}" style="margin-top:24px;">
      <button type="submit" style="display:inline-block;background:#111;color:#fff;border:0;
              padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">
        Yes, stop these emails
      </button>
    </form>
    <p style="margin-top:24px;font-size:13px;color:#666;">
      Nothing has changed yet. Close this page and you'll keep getting them.
    </p>
  `)
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
