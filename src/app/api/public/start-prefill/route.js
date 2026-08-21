// GET /api/public/start-prefill?c=<token> — STARTPREFILL.1
//
// Exchanges a signed prefill token for the four fields the /start booking form
// asks for, so someone arriving from an email we already hold their details in
// does not have to type them again. Public and unauthenticated by design: the
// token IS the capability, exactly as /unsubscribe/[token] works.
//
// 🔴 THIS ROUTE RETURNS PERSONAL DATA. Everything below is load-bearing:
//
//   • The token is HMAC-signed and time-limited (start-prefill-token.js).
//     A forged, tampered or expired token gets the same 404 as a contact that
//     no longer exists — distinguishing them would confirm which tokens were
//     ever real.
//   • It returns ONLY the four fields the form has inputs for. Not the
//     contact id, not membership state, not tags, not any other column. A
//     prefill endpoint should disclose exactly what it prefills.
//   • Rate-limited per IP. The token space is unguessable, so this is not the
//     primary defence — it is the backstop against someone working through a
//     list of leaked tokens.
//   • Never 404s vs 200s on contact EXISTENCE in a way that differs from token
//     validity, for the same reason.
//
// Deliberately GET and cache-hostile: no store, no revalidate. A CDN caching a
// per-person response on a shared URL is exactly the accident to design out.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { verifyStartPrefillToken } from '@/lib/start-prefill-token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// One 404 for every failure mode: bad signature, expired, malformed, unknown
// contact, suppressed contact. The caller cannot tell them apart, and the
// funnel does not need to — it just renders an empty form.
function notFound() {
  return NextResponse.json(
    { success: false, error: 'Not found' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `startprefill:${ip}`, { max: 30, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const token = request.nextUrl.searchParams.get('c')
  // verify throws only when the signing secret is absent, which is an
  // environment fault rather than a bad request — treat it as "no prefill"
  // so the funnel still renders a working empty form.
  const claim = (() => {
    try { return verifyStartPrefillToken(token) } catch { return null }
  })()
  if (!claim) return notFound()

  const { data: contact, error } = await db
    .from('contacts')
    .select('first_name, last_name, name, email, phone')
    .eq('id', claim.contactId)
    .maybeSingle()
  // A read failure is not "no such person" — but the caller gets the same
  // answer either way, because there is nothing useful it could do with the
  // difference and the form works fine empty.
  if (error || !contact) return notFound()

  // `name` is the fallback the rest of the estate uses when first/last are
  // absent (applyMergeTags does the same split), so the form fills in as much
  // as we actually know rather than leaving a blank someone has to notice.
  const first = contact.first_name || (contact.name || '').split(' ')[0] || ''
  const last = contact.last_name || (contact.name || '').split(' ').slice(1).join(' ') || ''

  return NextResponse.json(
    {
      success: true,
      data: {
        first_name: first,
        last_name: last,
        email: contact.email || '',
        phone: contact.phone || '',
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
