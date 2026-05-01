// POST /api/public/deposit/[token]/accept-and-pay   PUBLIC — no auth.
//
// The buyer accepts T&Cs and pays. Two things happen atomically-ish:
//   1. We stamp the acceptance on the car row (timestamp, IP,
//      terms_version snapshot — that's the buyer's evidence trail).
//   2. We create a Revolut Merchant order and persist its id +
//      hosted-checkout URL on the car. Returns the URL so the
//      browser can redirect.
//
// Idempotent on retry: if a Revolut order already exists AND it's
// still usable (PENDING / not expired), we return that same URL.
// New token = new order.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { createOrder, getOrder, RevolutError } from '@/lib/revolut'
import { getDepositBaseUrl, getRequestOrigin } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  // Must match the version the page rendered with — guard against
  // a buyer pressing pay long after the operator has edited the
  // terms. Forces a page reload so they see the new copy.
  terms_version: z.number().int().min(1),
})

export async function POST(request, { params }) {
  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Missing terms_version' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select(`
      id, make, model, location_id, deposit_token, deposit_token_expires_at,
      deposit_amount, deposit_status,
      deposit_revolut_order_id, deposit_revolut_checkout_url,
      locations ( id, car_deposit_terms_version )
    `)
    .eq('deposit_token', params.token)
    .maybeSingle()

  if (!car) {
    return NextResponse.json({ success: false, error: 'Invalid deposit link' }, { status: 404 })
  }

  // Reject expired tokens — same rule as the GET endpoint. Paid
  // deposits stay valid (won't reach this branch anyway, the next
  // check 409s on already-paid).
  if (car.deposit_status !== 'paid' && car.deposit_token_expires_at) {
    if (new Date(car.deposit_token_expires_at).getTime() <= Date.now()) {
      return NextResponse.json({
        success: false,
        error: 'This deposit link has expired. Please ask the dealer to send you a new one.',
        code: 'TOKEN_EXPIRED',
      }, { status: 410 })
    }
  }

  const currentVersion = car.locations?.car_deposit_terms_version || 1
  if (parsed.data.terms_version !== currentVersion) {
    return NextResponse.json({
      success: false,
      error: 'Terms have been updated. Please refresh the page and read the new terms before paying.',
      code: 'TERMS_VERSION_MISMATCH',
    }, { status: 409 })
  }

  if (car.deposit_status === 'paid') {
    return NextResponse.json({ success: false, error: 'Deposit has already been paid for this car.' }, { status: 409 })
  }

  // 1. Acceptance stamp. Always overwrites — repeated clicks are
  //    fine, the latest acceptance wins. xff parsing kept simple;
  //    Vercel sets x-forwarded-for as a single client IP for the
  //    edge so the first hop is the real visitor.
  const xff = request.headers.get('x-forwarded-for') || ''
  const acceptedIp = xff.split(',')[0].trim() || request.headers.get('x-real-ip') || null
  const acceptanceUpdates = {
    deposit_terms_accepted_at: new Date().toISOString(),
    deposit_terms_accepted_ip: acceptedIp,
    deposit_terms_accepted_version: currentVersion,
    deposit_status: car.deposit_status === 'paid' ? 'paid' : 'terms_accepted',
  }

  // 2. Revolut order. We return three handles to the frontend so it
  //    can drive the embedded card field (createCardField from the
  //    @revolut/checkout SDK):
  //      - public_id:    the SDK token, from the order response
  //      - checkout_url: hosted-page fallback if the SDK fails to load
  //      - order_id:     for our own audit trail
  //    Reuse the existing order if one already exists for this token
  //    AND we still have a public_id (i.e. it was created post-this-
  //    refactor). Older deposits may only have a checkout_url; in
  //    that case we'd need to recreate to get a fresh token, but
  //    that's a rare migration case — leave it for now.
  let checkoutUrl = car.deposit_revolut_checkout_url
  let orderId = car.deposit_revolut_order_id
  let publicId = null

  // For an existing order, re-fetch from Revolut to get the public_id
  // (we don't store it locally). Cheap — one extra GET on a retry.
  if (orderId && checkoutUrl && car.deposit_status !== 'paid') {
    try {
      const existing = await getOrder(orderId)
      publicId = existing?.public_id || null
    } catch {
      // If the order is gone (rare) fall through and create a new one.
      orderId = null
      checkoutUrl = null
    }
  }

  if (!publicId) {
    // Revolut redirects the buyer here after the hosted-page fallback
    // path. Must be the same domain the buyer started on so it doesn't
    // look like a phishing bounce. getDepositBaseUrl is the deposit
    // domain (pay.ccfautos.com); request origin is a final safety net.
    let baseUrl
    try { baseUrl = getDepositBaseUrl() } catch { baseUrl = getRequestOrigin(request) }
    const amountMinor = Math.round(Number(car.deposit_amount || 500) * 100)
    const carLabel = [car.make, car.model].filter(Boolean).join(' ') || 'Tesla'
    try {
      const order = await createOrder({
        amount: amountMinor,
        currency: 'EUR',
        description: `Car deposit — ${carLabel}`,
        captureMode: 'AUTOMATIC',
        // redirect_url still set so the hosted-page fallback works.
        redirectUrl: `${baseUrl}/cars/deposit/${car.deposit_token}/return`,
        metadata: {
          car_id: car.id,
          location_id: car.location_id,
          deposit_token: car.deposit_token,
        },
        idempotencyKey: `deposit-${car.deposit_token}`,
      })
      publicId = order?.public_id
      checkoutUrl = order?.checkout_url
      orderId = order?.id
      if (!publicId) throw new Error('Revolut returned no public_id')
      acceptanceUpdates.deposit_revolut_order_id = orderId
      acceptanceUpdates.deposit_revolut_checkout_url = checkoutUrl
    } catch (e) {
      const status = e instanceof RevolutError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
      // Still stamp the acceptance — the buyer's consent shouldn't be
      // lost just because Revolut failed. They can retry the payment.
      await db.from('cars').update(acceptanceUpdates).eq('id', car.id)
      return NextResponse.json({
        success: false,
        error: `Payment provider error: ${e.message || 'unknown'}`,
      }, { status })
    }
  }

  await db.from('cars').update(acceptanceUpdates).eq('id', car.id)

  return NextResponse.json({
    success: true,
    public_id: publicId,        // SDK token for createCardField()
    checkout_url: checkoutUrl,  // hosted-page fallback
    order_id: orderId,
  })
}
