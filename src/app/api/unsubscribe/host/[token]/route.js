// POST /api/unsubscribe/host/[token] — HOST-CONSENT.1, the RFC 8058
// one-click target for host marketing email.
//
// sendEmail's List-Unsubscribe header points at toListUnsubscribeUrl(pageUrl),
// which rewrites /unsubscribe/host/<t> → /api/unsubscribe/host/<t>. Until this
// route existed that path 404'd, so a Gmail/Yahoo one-click on a host email
// was silently lost (the page-visit path still worked).
//
// The HMAC token is the capability (host-unsubscribe.js). Same posture as the
// CRM one-click route: a POST arrives from the MAIL PROVIDER, often from a
// shared proxy pool, so the only limiter is a per-IP budget on INVALID tokens
// (probing) — a valid token is never rate-limited. Body is ignored; the
// suppression is per host by design and never touches UN1T consent.
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

  let ids = null
  try {
    ids = verifyHostUnsubToken(params.token)
  } catch (e) {
    logError('host-unsubscribe', 'token verification threw', { err: e })
  }
  if (!ids) {
    const limit = await checkRateLimit(db, `host-unsub-invalid:${ip}`, INVALID_TOKEN_BUDGET)
    if (!limit.allowed) return rateLimitResponse(limit)
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  const { data: host } = await db
    .from('event_hosts')
    .select('id, postmark_stream_id')
    .eq('id', ids.hostId)
    .maybeSingle()
  if (!host) return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })

  const result = await revokeHostConsent(db, {
    hostId: host.id, contactId: ids.contactId, source: 'host_one_click_unsubscribe', ipAddress: ip,
  })
  if (!result.ok) {
    if (result.code === '23503') {
      // FK violation: the contact was erased since the mail went out. There is
      // nobody left to unsubscribe — answer like any other dead token so the
      // provider stops retrying.
      return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
    }
    // The person pressed the button; do not report success on a failed write.
    logError('host-unsubscribe', 'one-click revoke failed', { err: result.error, host_id: host.id })
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

  return NextResponse.json({ success: true, data: { changed: result.changed } })
}

// A mail client that shows the List-Unsubscribe URL as a link sends a browser
// GET. Hand it to the landing page, which does the same write and shows a
// confirmation — never a 405 to a person trying to leave.
export async function GET(request, props) {
  const params = await props.params
  return NextResponse.redirect(`${getRequestOrigin(request)}/unsubscribe/host/${encodeURIComponent(params.token)}`, 302)
}
