// POST /api/public/trial-purchases/[id]/checkout — HATCHTRACK.1: send a Hatch
// Street (un1t.online) buyer back to payment for the purchase they already
// started, without retyping anything and without a second row.
//
// Public, no auth: the purchase id is the capability (the id the buyer's own
// browser was given, `?purchase=` on their return from the checkout, or the
// link in the follow-up email sent to their own address), exactly as it is for
// the status route beside this one. The answer is a checkout URL or a state,
// never the buyer's name, email or phone. Rate-limited per purchase and per IP.
//
// A buyer who has paid is never given a checkout: before one is handed back
// or made, the row must still await payment, its newest checkout must carry
// the paid-aware return, the mirror must hold no payment since the row was
// made, and un1t.online's live credits ledger must show nothing on the
// account (un1tRetryGate). Any of those reads failing answers `confirming`.
// Only a Hatch row that still awaits payment (un1tTrialRetryable). A Stillorgan
// row resumes through the status route's `resumable` checkout token instead.
// No charge, no grant, no account: resumeUn1tTrialCheckout hands back the
// row's own recent checkout, or asks un1t.online for a fresh one for the same
// row through the one write transport.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { normalizeTrialReturnPath } from '@/lib/trial-return-path'
import { listStudioPageSlugs, publicOrgIdForHost } from '@/lib/landing-pages'
import { resumeUn1tTrialCheckout } from '@/lib/trial-purchase-un1t-resume'

export const runtime = 'nodejs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Schema = z.object({ return_path: z.string().max(64).optional() })

const CHECK_LATER = 'We could not check your payment just now. Nothing has been charged twice. Please try again in a minute.'
const TRY_AGAIN = 'We could not open the payment page just now. Please try again in a moment.'

export async function POST(request, props) {
  const { id } = await props.params
  if (!ID.test(String(id || ''))) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const db = createServerClient()
  const ip = getClientIp(request)

  // Two buckets: a buyer pressing the button, and one address trying ids.
  const perPurchase = await checkRateLimit(db, `tpresume:${id}`, { max: 10, windowMs: 15 * 60_000 })
  if (!perPurchase.allowed) return rateLimitResponse(perPurchase, 'Too many attempts. Please wait a few minutes.')
  const perIp = await checkRateLimit(db, `tpresume-ip:${ip}`, { max: 20, windowMs: 15 * 60_000 })
  if (!perIp.allowed) return rateLimitResponse(perIp, 'Too many attempts. Please wait a few minutes.')

  // The body is optional (a bare POST returns to /trial).
  let body = {}
  try { body = Schema.parse(await request.json()) } catch { body = {} }
  const returnSlugs = body.return_path && body.return_path !== '/trial'
    ? await listStudioPageSlugs(db, await publicOrgIdForHost(request.headers.get('host')))
    : []
  const returnPath = normalizeTrialReturnPath(body.return_path, { slugs: returnSlugs })

  const out = await resumeUn1tTrialCheckout(db, { purchaseId: id, returnPath })
  if (out.kind === 'redirect') {
    // The URL goes to the browser once; it is never logged.
    return NextResponse.json({ success: true, data: { purchaseId: id, redirect_url: out.checkoutUrl, reused: out.reused } })
  }
  // Paid already, or it cannot be told from paid: never a checkout. The page
  // shows the being-confirmed screen. `retry_later`: a read failed, so the
  // CRM could not look (unknown is not unpaid); the buyer may try in a minute.
  if (out.kind === 'confirming') {
    return NextResponse.json(out.retryLater
      ? { success: false, code: 'confirming', retry_later: true, error: CHECK_LATER }
      : { success: false, code: 'already_paid' })
  }
  if (out.kind === 'not_found') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (out.kind === 'not_resumable') {
    // A state the page shows (paid already, expired, with the team), not a failure.
    return NextResponse.json({ success: false, code: 'not_resumable', state: out.state })
  }
  return NextResponse.json({ success: false, code: 'unavailable', error: TRY_AGAIN }, { status: 503 })
}
