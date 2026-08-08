// POST /api/public/offers/[slug]/checkout — start a Revolut checkout for one
// sale offer (OFFERS.4). Public (reached from the /offers pages on the
// marketing host). The amount is read from sale_offers ONLY — the request
// body carries buyer details, never a price. Returns the order token for the
// embedded widget; the webhook (/api/webhooks/revolut/offer-payments) and the
// public status route settle the outcome.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { createOrder } from '@/lib/revolut'
import { offerIsOpen } from '@/lib/sale-offers'
import { validateBody } from '@/lib/validate'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'

const checkoutSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(6).max(30),
})

export async function POST(request, props) {
  const { slug } = await props.params
  const parsed = await validateBody(request, checkoutSchema)
  if (!parsed.ok) return parsed.response

  const db = createServerClient()

  // Public order creation — cap per IP so a scripted client can't mint
  // unlimited Revolut orders (classbook precedent: 8/15min).
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `offerco:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const { data: offer } = await db.from('sale_offers').select('*').eq('slug', slug).maybeSingle()
  if (!offer) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!offerIsOpen(offer)) {
    return NextResponse.json({ success: false, error: 'sale_ended' }, { status: 410 })
  }

  const purchaseId = crypto.randomUUID()
  const order = await createOrder({
    amount: offer.price_cents, // server-side price ONLY
    currency: offer.currency,
    description: `UN1T — ${offer.name}`,
    metadata: { offer_purchase_id: purchaseId, offer_slug: offer.slug, location_id: offer.location_id },
    idempotencyKey: purchaseId,
  })

  const { error } = await db.from('offer_purchases').insert({
    id: purchaseId,
    offer_id: offer.id,
    location_id: offer.location_id,
    buyer_name: parsed.data.name,
    buyer_email: parsed.data.email,
    buyer_phone: parsed.data.phone,
    revolut_order_id: order.id,
    amount_cents: offer.price_cents,
    currency: offer.currency,
  })
  if (error) {
    // Never hand back a checkout token we can't reconcile — the webhook
    // would have no row to land on.
    return NextResponse.json({ success: false, error: 'Could not start checkout. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { purchaseId, checkout: { provider: 'revolut', token: order.token } },
  })
}
