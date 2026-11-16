// POST /api/public/buy/[token] — PAYLINK.1: "Continue to payment" on a
// staff-sent payment link (/buy/<token>).
//
// Public, no auth: the token in the path is the capability (32 random bytes;
// only its sha256 is stored on staff_payment_links). The answer is a state or
// un1t.online's hosted-checkout URL, handed to the browser once and never
// logged or stored. Never the person's details. Rate-limited per IP.
//
// startStaffLinkCheckout does the work: re-reads the link, the contact (fresh
// by id), the current product and the mirror (a link already paid is never
// sent to pay again), finds or creates the un1t.online account (created only
// with `acceptTerms: true` on THIS request, the customer's own tick), then
// asks un1t.online for its checkout. The CRM never charges a card.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { startStaffLinkCheckout } from '@/lib/staff-payment-link-checkout'

export const runtime = 'nodejs'

const Schema = z.object({ acceptTerms: z.boolean().optional() })

export async function POST(request, props) {
  const { token } = await props.params
  const db = createServerClient()

  const limit = await checkRateLimit(db, `paylink:${getClientIp(request)}`, { max: 10, windowMs: 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many attempts. Please wait a minute.')

  // The body is optional (a bare POST is an existing member's press).
  let body = {}
  try { body = Schema.parse(await request.json()) } catch { body = {} }

  const out = await startStaffLinkCheckout(db, { token: String(token || ''), acceptTerms: body.acceptTerms === true })
  if (out.kind === 'not_found') return NextResponse.json({ success: false, error: 'Not found', data: { kind: 'not_found' } }, { status: 404 })
  if (out.kind === 'redirect') return NextResponse.json({ success: true, data: { kind: 'redirect', url: out.url } })
  if (out.kind === 'unavailable') {
    return NextResponse.json({ success: false, error: 'Please try again in a minute.', data: { kind: 'unavailable' } }, { status: 503 })
  }
  // paid / expired / help / terms_required: a state the page shows, not a failure.
  return NextResponse.json({ success: true, data: { kind: out.kind } })
}
