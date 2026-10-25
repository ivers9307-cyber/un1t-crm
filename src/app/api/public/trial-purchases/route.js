// POST /api/public/trial-purchases — PAIDTRIAL.1: start a paid trial purchase
// from the /trial page. The studio and the product come from the landing row
// the body's `path` names (its paid_trial block); the price is the BLOCK's,
// never the client's. Captures the lead exactly as the class funnel does
// (contact, lead_source, attribution, consent, deal placement, Meta Lead),
// inserts an `awaiting_payment` trial_purchases row and opens the provider
// payment. The webhook or the status route releases the row to the processor
// once the money is in. No auth; rate-limited per landing path and IP.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { sanitiseVisitOrigin } from '@/lib/visit-origin'
import { writeContactTag } from '@/lib/contact-tags'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { placeWaitlistEntry } from '@/lib/waitlist-entry'
import { resolveLandingPath } from '@/lib/public-landing'
import { paidTrialConfigFromBlocks } from '@/lib/paid-trial'
import { createTrialPurchasePayment } from '@/lib/trial-purchase-payments'
import { locationCanTakePayments } from '@/lib/location-payments'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  path: z.string().trim().max(64).optional(),
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50).refine(isValidMobileNumber, 'Enter a valid mobile number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick consent to continue' }),
  attribution: z.object({
    utm_campaign: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(),
    utm_term: z.string().max(200).optional(),
    ad_provider: z.string().max(50).optional(),
    ad_external_id: z.string().max(200).optional(),
    fbclid: z.string().max(500).optional(),
    fbp: z.string().max(100).optional(),
  }).optional(),
  lead_event_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  visit: z.object({
    referrer: z.string().max(2000).optional(),
    landing_path: z.string().max(500).optional(),
  }).optional(),
})

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  const landingPath = resolveLandingPath(b.path)
  const limit = await checkRateLimit(db, `trialbuy:${landingPath}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')

  const { data: page, error: pageErr } = await db.from('landing_page_settings')
    .select('location_id, blocks').eq('public_path', landingPath).maybeSingle()
  if (pageErr) {
    logError('trialbuy', 'landing row unreadable', { err: pageErr, landingPath })
    return NextResponse.json({ success: false, code: 'unavailable', error: 'The trial is not available right now. Please try again in a moment.' }, { status: 503 })
  }
  const product = page?.location_id ? paidTrialConfigFromBlocks(page.blocks, landingPath) : null
  if (!product) {
    return NextResponse.json({ success: false, code: 'not_configured', error: 'The trial is not available right now.' }, { status: 400 })
  }
  const locationId = page.location_id

  const { data: location, error: locErr } = await db.from('locations')
    .select('id, name, organization_id, settings').eq('id', locationId).maybeSingle()
  if (locErr || !location) {
    logError('trialbuy', 'location unreadable', { err: locErr, locationId })
    return NextResponse.json({ success: false, code: 'unavailable', error: 'The trial is not available right now. Please try again in a moment.' }, { status: 503 })
  }
  if (!locationCanTakePayments(location)) {
    return NextResponse.json({ success: false, code: 'payments_unavailable', error: 'Payments are not set up for this studio yet.' }, { status: 400 })
  }

  // ── Capture the lead (the class funnel's steps, same helpers) ──
  const name = `${b.first_name} ${b.last_name}`.trim()
  const email = b.email.toLowerCase()
  const contactId = await findOrCreateRaceContact({
    db, locationId, email, name, phone: b.phone, restrictToOrg: true,
    insertFields: { source: 'paid_trial', first_name: b.first_name, last_name: b.last_name },
  })
  if (!contactId) return NextResponse.json({ success: false, code: 'capture_failed', error: 'Could not capture your details. Please try again.' }, { status: 500 })

  // A matched contact with no first/last (an old import) gets the typed names,
  // because the Glofox register needs both. Stamp-if-null, best-effort.
  try {
    await db.from('contacts').update({ first_name: b.first_name, last_name: b.last_name }).eq('id', contactId).is('first_name', null)
  } catch (e) { logWarn('trialbuy', 'first/last stamp failed', { err: e }) }
  try { await db.from('contacts').update({ lead_source: product.leadSource }).eq('id', contactId).is('lead_source', null) } catch (e) { logWarn('trialbuy', 'lead_source failed', { err: e }) }
  try {
    await db.from('contacts').update({ last_lead_source: product.leadSource, last_lead_source_at: new Date().toISOString() }).eq('id', contactId)
  } catch (e) { logWarn('trialbuy', 'last_lead_source failed', { err: e }) }
  try {
    const a = b.attribution || {}
    const patch = {}
    for (const k of ['utm_campaign', 'utm_content', 'utm_term', 'ad_external_id']) {
      if (a[k] && String(a[k]).length <= 200) patch[k] = String(a[k])
    }
    if (Object.keys(patch).length) {
      if (a.ad_provider && String(a.ad_provider).length <= 50) patch.ad_provider = String(a.ad_provider)
      patch.attributed_at = new Date().toISOString()
      await db.from('contacts').update(patch).eq('id', contactId).is('ad_external_id', null)
    }
  } catch (e) { logWarn('trialbuy', 'utm persist failed', { err: e }) }
  try {
    const v = sanitiseVisitOrigin(b.visit)
    if (v) {
      await db.from('contacts')
        .update({ visit_referrer: v.referrer, visit_landing_path: v.landing_path, visit_captured_at: new Date().toISOString() })
        .eq('id', contactId).is('visit_captured_at', null)
    }
  } catch (e) { logWarn('trialbuy', 'visit origin failed', { err: e }) }
  try { await writeContactTag(db, { contactId, locationId, tag: product.tag }) } catch (e) { logWarn('trialbuy', 'tag failed', { err: e }) }
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'paid_trial', ipAddress: ip, locationId })
  } catch (e) { logWarn('trialbuy', 'consent failed', { err: e }) }
  try { await placeWaitlistEntry(db, { contactId, locationId, title: b.first_name || 'Trial buyer' }) } catch (e) { logWarn('trialbuy', 'deal placement failed', { err: e }) }

  // ── The purchase row, then the provider payment ──
  const { fbcFromFbclid } = await import('@/lib/meta-capi')
  const attribution = {
    ...(b.attribution || {}),
    fbc: fbcFromFbclid(b.attribution?.fbclid) || undefined,
    event_source_url: product.eventSourceUrl,
  }
  delete attribution.fbclid
  const { data: row, error: insErr } = await db.from('trial_purchases').insert({
    location_id: locationId,
    contact_id: contactId,
    landing_path: landingPath,
    customer_name: name,
    first_name: b.first_name,
    last_name: b.last_name,
    customer_email: email,
    customer_phone: b.phone,
    product_name: product.productName,
    membership_id: product.membershipId,
    plan_code: product.planCode,
    duration_days: product.durationDays,
    amount_cents: product.priceCents,
    currency: product.currency,
    status: 'awaiting_payment',
    lead_event_id: b.lead_event_id || null,
    attribution,
  }).select('*').single()
  if (insErr || !row) {
    logError('trialbuy', 'purchase insert failed', { err: insErr, contactId })
    return NextResponse.json({ success: false, code: 'unavailable', error: 'Could not start your purchase. Please try again.' }, { status: 500 })
  }

  let payment
  try {
    payment = await createTrialPurchasePayment({ db, purchase: row, location, amountCents: product.priceCents, currency: product.currency })
  } catch (e) {
    logError('trialbuy', 'payment create failed', { err: e, purchaseId: row.id })
    return NextResponse.json({ success: false, code: 'checkout_failed', error: 'Could not start checkout. Please try again.' }, { status: 502 })
  }

  // Meta Lead (the studio's own dataset), sharing the browser's event id.
  try {
    const { sendWebsiteConversion } = await import('@/lib/meta-capi')
    await sendWebsiteConversion(db, {
      locationId, eventName: 'Lead', email, phone: b.phone,
      eventSourceUrl: product.eventSourceUrl,
      eventId: b.lead_event_id || `triallead-${contactId}`,
      contentName: product.productName,
      fbc: attribution.fbc, clientIp: ip,
      userAgent: request.headers.get('user-agent') || undefined,
      firstName: b.first_name, lastName: b.last_name, externalId: contactId,
      fbp: b.attribution?.fbp,
    })
  } catch (e) { logWarn('trialbuy', 'capi lead failed', { err: e }) }

  return NextResponse.json({ success: true, data: {
    purchaseId: payment.purchaseId,
    checkout: payment.checkout,
    amount_cents: product.priceCents,
    currency: product.currency,
    product_name: product.productName,
  } })
}
