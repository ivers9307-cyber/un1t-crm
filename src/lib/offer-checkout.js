// BLACKFRIDAY.4 — the offer checkout handler, shared by
//   POST /api/public/offers/[studio]/[slug]/checkout   (the per-studio pages)
//   POST /api/public/offers/[studio]/checkout          (legacy: its segment is a
//        Stillorgan offer slug, kept for pages loaded before the deploy)
//
// Public (reached from the /offers pages on the marketing and tenant hosts).
// The amount is read from sale_offers ONLY; the body carries buyer details,
// never a price. Every query is scoped to the studio's location: the offer is
// read by (location_id, slug), so one studio's slug never sells another's.
//
// Two rails:
//   - un1t.online (a studio whose membership_source is un1t_online, for a
//     membership or a class pack): the offer must name its un1t.online
//     product, the mirrored product's price must equal the offer's, writes
//     must be on and the buyer must tick un1t.online's terms; then
//     offer-checkout-un1t.js finds or creates the account and returns
//     un1t.online's hosted checkout URL. Such an offer NEVER falls through to
//     Revolut (a membership with no product yet is 409 not_configured).
//   - Revolut (everything else): the order token for the embedded widget; the
//     webhook (/api/webhooks/revolut/offer-payments), the public status route
//     and the reconcile cron settle the outcome.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { createOrder } from '@/lib/revolut'
import { offerIsOpen, offerIsUpcoming } from '@/lib/sale-offers'
import { resolveOfferStudio } from '@/lib/offer-studios'
import { startUn1tOfferCheckout } from '@/lib/offer-checkout-un1t'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { studioTermsCopy } from '@/lib/landing-pages'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'
import { validateBody } from '@/lib/validate'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { logError, logWarn } from '@/lib/log'

const LOG = 'offers'

export const offerCheckoutSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(6).max(30),
  // un1t.online offers only: the terms and waiver tick (judged below).
  terms_accepted: z.boolean().optional(),
})

// The categories a un1t.online studio sells through un1t.online's checkout.
const UN1T_CATEGORIES = new Set(['membership', 'class_pack'])

const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const BUSY = () => NextResponse.json({ success: false, code: 'busy', error: 'Busy right now, please try again in a minute.' }, { status: 503 })
const NOT_CONFIGURED = () => NextResponse.json({
  success: false, code: 'not_configured', error: "This offer can't be bought online right now. Please contact the studio.",
}, { status: 409 })

// Redirect-flow payment methods (Revolut Pay app-handoff on mobile, some
// 3DS journeys) need a return target on the ORDER; without one the widget
// suppresses Revolut Pay on phones entirely. The origin is allowlisted to the
// brand domains (un1tdublin.com, repset.ie and their subdomains, REPSET-P6) so
// a forged Origin header can't point Revolut's redirect anywhere else; no
// Origin falls back to the un1tdublin marketing host.
function brandOrigin(request) {
  try {
    const h = new URL(request.headers.get('origin') || '').hostname
    if (
      h === 'un1tdublin.com' || h.endsWith('.un1tdublin.com') ||
      h === 'repset.ie' || h.endsWith('.repset.ie')
    ) {
      return request.headers.get('origin')
    }
  } catch { /* fall through to default */ }
  return 'https://www.un1tdublin.com'
}

/**
 * @param {Request} request
 * @param {{ studio: string, slug: string }} target the /offers/<studio>/<slug> pair
 * @returns {Promise<Response>}
 */
export async function handleOfferCheckout(request, { studio: studioKey, slug }) {
  const parsed = await validateBody(request, offerCheckoutSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const db = createServerClient()

  // Public order creation: cap per IP so a scripted client can't mint
  // unlimited orders or accounts (classbook precedent: 8/15min).
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `offerco:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  let resolved
  try {
    resolved = await resolveOfferStudio(db, studioKey)
  } catch (e) {
    logError(LOG, 'offer studio unreadable', { studio: studioKey, code: e?.code ?? null })
    return BUSY()
  }
  if (!resolved) return NOT_FOUND()
  const { studio, location } = resolved

  const { data: offer, error: offerErr } = await db.from('sale_offers')
    .select('*')
    .eq('location_id', location.id)
    .eq('slug', slug)
    .maybeSingle()
  if (offerErr) {
    logError(LOG, 'sale offer unreadable', { locationId: location.id, code: offerErr.code ?? null })
    return BUSY()
  }
  if (!offer) return NOT_FOUND()
  if (offerIsUpcoming(offer)) {
    return NextResponse.json({ success: false, code: 'not_open_yet', error: "This offer isn't open yet." }, { status: 409 })
  }
  if (!offerIsOpen(offer)) {
    return NextResponse.json({ success: false, error: 'sale_ended' }, { status: 410 })
  }

  const purchaseId = crypto.randomUUID()

  if (location.membership_source === 'un1t_online' && UN1T_CATEGORIES.has(offer.category)) {
    return un1tCheckout(db, { request, body, studio, location, offer, purchaseId })
  }
  return revolutCheckout(db, { request, body, studio, offer, purchaseId })
}

async function un1tCheckout(db, { body, studio, location, offer, purchaseId }) {
  // A membership or pack here is sold by un1t.online only: no product, no sale.
  if (!offer.un1t_product_id) {
    logWarn(LOG, 'un1t offer has no un1t.online product', { offerId: offer.id, locationId: location.id })
    return NOT_CONFIGURED()
  }

  // The price the buyer sees is the offer's; un1t.online charges its product's.
  // The two must agree or the page would quote the wrong amount.
  const { data: product, error: productErr } = await db.from('un1t_products')
    .select('price_cents')
    .eq('location_id', location.id)
    .eq('un1t_id', offer.un1t_product_id)
    .limit(1)
    .maybeSingle()
  if (productErr) {
    logError(LOG, 'un1t product unreadable', { offerId: offer.id, locationId: location.id, code: productErr.code ?? null })
    return BUSY()
  }
  if (!product) {
    logError(LOG, 'un1t offer product is not in the mirror', { offerId: offer.id, locationId: location.id, productId: offer.un1t_product_id })
    return NOT_CONFIGURED()
  }
  if (product.price_cents !== offer.price_cents) {
    logError(LOG, 'un1t product price differs from the offer', {
      offerId: offer.id, locationId: location.id, productId: offer.un1t_product_id,
      offerCents: offer.price_cents, productCents: product.price_cents ?? null,
    })
    return NextResponse.json({
      success: false, code: 'price_mismatch', error: "This offer can't be bought online right now. Please contact the studio.",
    }, { status: 409 })
  }

  if (!un1tWriteSettingsFrom(location.settings).writesEnabled) return NOT_CONFIGURED()

  // A new un1t.online account needs the buyer's acceptance of the studio's
  // terms and liability waiver (as /trial). The tick's wording rides on the
  // refusal so the page can show it and try again.
  if (body.terms_accepted !== true) {
    const terms = un1tTermsPayload({ terms: await studioTermsCopy(db, location.id), studioName: location.name, publicPath: studio.key })
    return NextResponse.json({
      success: false, code: 'terms_required', error: terms.required_message,
      issues: { terms_accepted: terms.required_message }, terms,
    }, { status: 400 })
  }

  const email = body.email.toLowerCase()
  const contactId = await findOrCreateRaceContact({
    db, locationId: location.id, email, name: body.name, phone: body.phone,
    restrictToOrg: true, insertFields: { lead_source: 'offer_sale' },
  })
  if (!contactId) {
    return NextResponse.json({ success: false, code: 'capture_failed', error: 'Could not capture your details. Please try again.' }, { status: 500 })
  }
  const { data: contact, error: contactErr } = await db.from('contacts')
    .select('id, email, first_name, last_name, name, phone, un1t_user_id')
    .eq('id', contactId)
    .maybeSingle()
  if (contactErr || !contact) {
    logError(LOG, 'offer buyer contact unreadable', { contactId, locationId: location.id, code: contactErr?.code ?? null })
    return BUSY()
  }

  // The acceptance, with the documents' version at the time of the tick
  // (null when they could not be read; the tick still stands).
  let version = null
  try { version = (await readUn1tLegalDocs(db, location.id)).version ?? null } catch (e) {
    logWarn(LOG, 'legal documents version unread', { locationId: location.id, code: e?.code ?? null })
  }
  const terms = { terms_accepted_at: new Date().toISOString(), terms_source: 'website', terms_version: version }

  const outcome = await startUn1tOfferCheckout(db, {
    offer, location, contact, purchaseId, terms, studioKey: studio.key,
    buyer: { name: body.name, email, phone: body.phone },
  })
  if (outcome.kind === 'redirect') {
    // The URL goes to the browser once; it is never stored or logged.
    return NextResponse.json({ success: true, data: { purchaseId, checkout: { provider: 'un1t_online', url: outcome.checkoutUrl } } })
  }
  if (outcome.kind === 'help_filed') {
    return NextResponse.json({
      success: false, code: 'help_filed', error: "We couldn't open the checkout. The team has your details and will be in touch today.",
    }, { status: 202 })
  }
  return BUSY()
}

async function revolutCheckout(db, { request, body, studio, offer, purchaseId }) {
  let order
  try {
    order = await createOrder({
      amount: offer.price_cents, // server-side price ONLY
      currency: offer.currency,
      description: `UN1T — ${offer.name}`,
      metadata: { offer_purchase_id: purchaseId, offer_slug: offer.slug, location_id: offer.location_id },
      idempotencyKey: purchaseId,
      // Return to the studio's product page with the purchase id; the page
      // resumes in a confirming state and the status poll settles it.
      redirectUrl: `${brandOrigin(request)}/offers/${studio.key}/${encodeURIComponent(offer.slug)}?purchase=${purchaseId}`,
      // REVPAY.7 — a fresh order per checkout click (random purchaseId), paid in
      // the page's widget: the 30-minute default expiry applies.
      customer: { email: body.email, fullName: body.name },
      // REVPAY.13 — reuse this buyer's Revolut customer (found-or-created by email).
      db,
      merchantReference: `offer:${purchaseId}`,
      statementDescriptorSuffix: offer.name,
    })
  } catch (e) {
    logError(LOG, 'revolut offer order create failed', { purchaseId, offerId: offer.id, locationId: offer.location_id, errClass: e?.name })
    return NextResponse.json({ success: false, error: 'Could not start checkout. Please try again.' }, { status: 502 })
  }

  const { error } = await db.from('offer_purchases').insert({
    id: purchaseId,
    offer_id: offer.id,
    location_id: offer.location_id,
    buyer_name: body.name,
    buyer_email: body.email,
    buyer_phone: body.phone,
    revolut_order_id: order.id,
    amount_cents: offer.price_cents,
    currency: offer.currency,
    payment_provider: 'revolut',
    origin: 'page',
  })
  if (error) {
    // Never hand back a checkout token we can't reconcile: the webhook
    // would have no row to land on.
    logError(LOG, 'revolut offer purchase insert failed', { purchaseId, offerId: offer.id, locationId: offer.location_id, code: error.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not start checkout. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { purchaseId, checkout: { provider: 'revolut', token: order.token } },
  })
}
