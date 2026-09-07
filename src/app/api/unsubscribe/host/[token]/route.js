// POST /api/unsubscribe/host/[token] — HOST-CONSENT.1, the RFC 8058
// one-click target for host marketing email, and HOST-EMAILS.2's single
// writer for a host opt-out.
//
// sendEmail's List-Unsubscribe header points at toListUnsubscribeUrl(pageUrl),
// which rewrites /unsubscribe/host/<t> → /api/unsubscribe/host/<t>. Until this
// route existed that path 404'd, so a Gmail/Yahoo one-click on a host email
// was silently lost (the page-visit path still worked).
//
// The HMAC token is the capability (host-unsubscribe.js). Same posture as the
// CRM one-click route: a POST arrives from the MAIL PROVIDER, often from a
// shared proxy pool, so the only limiter is a per-IP budget on INVALID tokens
// (probing) — a valid token is never rate-limited.
//
// HOST-EMAILS.2 — the landing page's confirm button also posts here, with a
// hidden `redirect=1` field, and expects a 303 browser redirect back to the
// page rather than JSON. An RFC 8058 one-click POST from a mail provider also
// arrives form-encoded (List-Unsubscribe=One-Click) but never carries
// `redirect`, so it keeps getting JSON exactly as before. The two entry
// points are also tagged with different consent sources so a reversal can
// tell them apart.
//
// Public by design → registered in scripts/check-route-guards.mjs EXEMPT and
// src/proxy.js already allowlists the '/api/unsubscribe/' prefix.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyHostUnsubToken } from '@/lib/host-unsubscribe'
import { revokeHostConsent } from '@/lib/host-consent'
import { suppressAtPostmark } from '@/lib/postmark-suppressions'
import { getClientIp, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { logError, logWarn } from '@/lib/log'
import { getRequestOrigin } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INVALID_TOKEN_BUDGET = { max: 30, windowMs: 15 * 60_000 }

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()
  const ip = getClientIp(request)

  // HOST-EMAILS.2 — the landing page's confirm button posts here with
  // redirect=1 and expects a browser redirect; a mail provider's RFC 8058
  // one-click POST also arrives form-encoded (List-Unsubscribe=One-Click)
  // but never carries redirect, so it keeps getting JSON.
  let wantsRedirect = false
  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    wantsRedirect = form?.get('redirect') === '1'
  }
  const origin = getRequestOrigin(request)
  const pageUrl = (qs) => `${origin}/unsubscribe/host/${encodeURIComponent(params.token)}${qs}`

  let ids = null
  try {
    ids = verifyHostUnsubToken(params.token)
  } catch (e) {
    logError('host-unsubscribe', 'token verification threw', { err: e })
  }
  if (!ids) {
    const limit = await checkRateLimit(db, `host-unsub-invalid:${ip}`, INVALID_TOKEN_BUDGET)
    if (!limit.allowed) return rateLimitResponse(limit)
    if (wantsRedirect) return NextResponse.redirect(pageUrl('?error=1'), 303)
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  const { data: host } = await db
    .from('event_hosts')
    .select('id, postmark_stream_id')
    .eq('id', ids.hostId)
    .maybeSingle()
  if (!host) {
    if (wantsRedirect) return NextResponse.redirect(pageUrl('?error=1'), 303)
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  const result = await revokeHostConsent(db, {
    hostId: host.id, contactId: ids.contactId,
    source: wantsRedirect ? 'host_unsubscribe_page' : 'host_one_click_unsubscribe',
    ipAddress: ip,
  })
  if (!result.ok) {
    if (result.code === '23503') {
      // FK violation: the contact was erased since the mail went out. There is
      // nobody left to unsubscribe — answer like any other dead token so the
      // provider stops retrying.
      if (wantsRedirect) return NextResponse.redirect(pageUrl('?error=1'), 303)
      return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
    }
    // The person pressed the button; do not report success on a failed write.
    logError('host-unsubscribe', 'one-click revoke failed', { err: result.error, host_id: host.id })
    if (wantsRedirect) return NextResponse.redirect(pageUrl('?error=1'), 303)
    return NextResponse.json({ success: false, error: 'Could not unsubscribe, please try again.' }, { status: 500 })
  }

  // Pushed on every click, not only when the row flipped: the consent-drift
  // cron reconciles the UN1T broadcast stream only, so a repeat click is the
  // one retry a failed host-stream push gets.
  // Second, independent refusal at Postmark on the HOST's stream — best-effort.
  if (host.postmark_stream_id) {
    try {
      const { data: contact } = await db.from('contacts').select('email').eq('id', ids.contactId).maybeSingle()
      if (contact?.email) {
        const push = await suppressAtPostmark(contact.email, { stream: host.postmark_stream_id })
        if (push?.failed?.length) logWarn('host-unsubscribe', 'Postmark host-stream suppress failed', { message: push.failed[0]?.message })
      }
    } catch (e) {
      logWarn('host-unsubscribe', 'Postmark host-stream suppress threw', { err: e?.message || String(e) })
    }
  }

  if (wantsRedirect) return NextResponse.redirect(pageUrl('?done=1'), 303)
  return NextResponse.json({ success: true, data: { changed: result.changed } })
}

// A mail client that shows the List-Unsubscribe URL as a link sends a browser
// GET. Hand it to the landing page rather than 405 a person trying to leave.
// The landing page itself no longer writes on GET (HOST-EMAILS.2) — it shows
// a confirm button whose POST (redirect=1) lands back in this same handler.
export async function GET(request, props) {
  const params = await props.params
  return NextResponse.redirect(`${getRequestOrigin(request)}/unsubscribe/host/${encodeURIComponent(params.token)}`, 302)
}
