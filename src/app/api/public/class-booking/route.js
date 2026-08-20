// POST /api/public/class-booking — public enqueue for the ClassFunnel block /
// /start wizard's class path. Location resolved from the body `path`
// (public_path; defaults to 'stillorgan'); the chosen class is re-validated
// against that location's live bookable list.
// Captures the lead in the CRM (contact + new_lead deal + lead_source +
// tag = "reclassify as a fresh lead") then enqueues a class_booking_requests
// row for the process-class-bookings cron. Returns instantly; the booking +
// WhatsApp confirmation happen async. No auth; rate-limited.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { logWarn } from '@/lib/log'
import { resolveLandingPath, classFunnelConfigFromBlocks } from '@/lib/public-landing'
import { createClassBookingPayment } from '@/lib/class-booking-payments'
import { locationCanTakePayments } from '@/lib/location-payments'

export const runtime = 'nodejs'

const Schema = z.object({
  event_id: z.string().trim().min(1).max(64),
  path: z.string().trim().max(64).optional(),
  class_name: z.string().trim().max(200).optional(),
  starts_at: z.string().trim().max(40).optional(),
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50).refine(isValidMobileNumber, 'Enter a valid mobile number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick consent to continue' }),
  // ADS-REPORT.2 — optional first-touch ad-click attribution captured by the
  // /start funnel from the landing URL's UTM/meta_ad_id params. Low-trust:
  // sanitised + length-capped before it ever reaches the DB (see below).
  attribution: z.object({
    utm_campaign: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(),
    utm_term: z.string().max(200).optional(),
    ad_provider: z.string().max(50).optional(),
    ad_external_id: z.string().max(200).optional(),
  }).optional(),
})

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  // Body is validated FIRST (pure, no DB) so the landing path is known before
  // the limiter — a malformed body 400s without consuming any tenant's window.
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  const landingPath = resolveLandingPath(b.path)
  // SAAS-6: tenant-keyed by the RESOLVED landing path so one location's booking
  // traffic can't exhaust another's window for the same IP.
  const limit = await checkRateLimit(db, `classbook:${landingPath}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')

  const { data: page } = await db.from('landing_page_settings')
    .select('location_id, blocks').eq('public_path', landingPath).maybeSingle()
  if (!page?.location_id) {
    return NextResponse.json({ success: false, error: 'Class booking is not available right now.' }, { status: 400 })
  }
  const locationId = page.location_id
  const name = `${b.first_name} ${b.last_name}`.trim()
  // Nurture tag / lead_source / CAPI eventSourceUrl are DERIVED from this
  // location's class_funnel block (defaults reproduce today's Stillorgan
  // values) — never Stillorgan literals, so a second gym on this block isn't
  // mistagged 'stillorgan-start' or misreported to Meta as /start.
  const { tag, leadSource, eventSourceUrl, trialMembershipId, trialPlanCode, priceCents, currency } = classFunnelConfigFromBlocks(page.blocks, landingPath)

  // Paid intro? Load the location's payment settings so we can resolve the rail.
  // `wantsPayment` gates the paid branch; `paid` is only true once we've also
  // confirmed the location can actually charge (Revolut always; Stripe needs a
  // connected account).
  const wantsPayment = Number.isFinite(priceCents) && priceCents > 0
  let locationForPay = null
  if (wantsPayment) {
    const { data: loc } = await db.from('locations').select('id, settings').eq('id', locationId).maybeSingle()
    locationForPay = loc || null
  }
  const paid = wantsPayment && locationCanTakePayments(locationForPay)

  // Validate the chosen class against the live bookable list — never trust the
  // client's event_id / class_name / starts_at. We use the SERVER's name + start
  // for storage so spoofed text can't reach Glofox, /approvals or the WhatsApp
  // confirmation, and an event_id not in the list is rejected (don't capture a
  // lead for a class that can't be booked).
  const { listPublicClasses } = await import('@/lib/public-classes')
  let chosen = null
  try {
    const classes = await listPublicClasses(db, locationId, 14)
    chosen = classes.find((c) => c.event_id === b.event_id) || null
  } catch (e) { logWarn('classbook', 'class validate failed', { err: e }) }
  if (!chosen) {
    // STARTCONV.1 — a machine-readable code, because the funnel now collects
    // details AFTER the class is chosen. That widens the gap between picking
    // and submitting from milliseconds to however long someone takes typing,
    // so this stopped being a rarity. The client branches on `code` to send
    // them back to the picker with their details intact; matching on the
    // prose would break the moment anyone edits it.
    return NextResponse.json({ success: false, code: 'class_unavailable', error: 'That class is no longer available — please pick another.' }, { status: 400 })
  }

  // restrictToOrg (LEADCAP.1): a public form must not resolve (and then enqueue
  // a Glofox booking / write consent against) a contact in another ORGANISATION.
  // Sibling locations in the same org are fine — and necessary, since
  // `contacts_email_unique` is global and a location-only match left a known
  // email unable to insert (23505 → 500).
  const contactId = await findOrCreateRaceContact({ db, locationId, email: b.email.toLowerCase(), name, phone: b.phone, restrictToOrg: true })
  if (!contactId) return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })

  try { await db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null) } catch (e) { logWarn('classbook', 'lead_source failed', { err: e }) }
  // ADS-REPORT.2 — first-touch ad-click attribution (stamp-if-null). Marketing
  // params are low-trust: sanitised + length-capped. Only stamp when a real ad
  // signal is present so organic /start visitors never get ad_provider='meta'.
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
  } catch (e) { logWarn('attribution', 'utm persist failed', { err: e }) }
  try { await writeContactTag(db, { contactId, locationId, tag }) } catch (e) { logWarn('classbook', 'tag failed', { err: e }) }
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'start_class', ipAddress: ip, locationId })
  } catch (e) { logWarn('classbook', 'consent failed', { err: e }) }
  try {
    const { data: openDeal } = await db.from('deals').select('id').eq('contact_id', contactId).eq('status', 'open').maybeSingle()
    if (!openDeal) {
      const { data: stage } = await db.from('pipeline_stages').select('id').eq('location_id', locationId).eq('slug', 'new_lead').maybeSingle()
      if (stage) await db.from('deals').insert({ title: b.first_name || 'Class lead', contact_id: contactId, stage_id: stage.id, location_id: locationId, status: 'open' })
    }
  } catch (e) { logWarn('classbook', 'deal failed', { err: e }) }

  // Dedupe: if this contact already has an active/booked request for this class
  // (double-submit, refresh, retry), don't create a second. Treat as success.
  // `awaiting_payment` is included so a double-submit of a PAID booking doesn't
  // open a second provider order; a failed/expired payment (`payment_failed`) is
  // deliberately NOT included so the customer can retry checkout.
  try {
    const { data: existing } = await db.from('class_booking_requests')
      .select('id').eq('contact_id', contactId).eq('glofox_event_id', b.event_id)
      .in('status', ['queued', 'processing', 'booked', 'awaiting_payment']).limit(1).maybeSingle()
    if (existing) return NextResponse.json({ success: true, data: { queued: true, deduped: true } })
  } catch (e) { logWarn('classbook', 'dedupe check failed', { err: e }) }

  // class_name + starts_at come from the SERVER-validated class, not the client.
  const { data: queuedRow, error: insErr } = await db.from('class_booking_requests').insert({
    location_id: locationId, contact_id: contactId,
    glofox_event_id: b.event_id, class_name: chosen.name,
    starts_at: chosen.starts_at,
    customer_name: name, customer_email: b.email.toLowerCase(), customer_phone: b.phone,
    trial_membership_id: trialMembershipId, trial_plan_code: trialPlanCode,
    status: paid ? 'awaiting_payment' : 'queued',
  }).select('id, class_name').maybeSingle()
  if (insErr) {
    // A unique-violation (23505) means a concurrent request won the race for the
    // same (contact, class) — that's a successful dedupe, not an error.
    if (insErr.code === '23505') return NextResponse.json({ success: true, data: { queued: true, deduped: true } })
    logWarn('classbook', 'enqueue failed', { err: insErr })
    return NextResponse.json({ success: false, error: 'Could not start your booking. Please try again.' }, { status: 500 })
  }

  // Paid intro: open a provider payment and hold the booking `awaiting_payment`.
  // The signed webhook (or the poll route's re-check) releases it to the queue
  // once the money clears. The CAPI Lead below still fires — a captured lead is
  // a lead regardless of whether they go on to pay.
  let paymentResponse = null
  if (paid && queuedRow?.id) {
    try {
      const pay = await createClassBookingPayment({
        db,
        request: { id: queuedRow.id, location_id: locationId, class_name: queuedRow.class_name },
        location: locationForPay,
        amountCents: priceCents,
        currency,
      })
      paymentResponse = { requiresPayment: true, paymentId: pay.paymentId, checkout: pay.checkout }
    } catch (e) {
      logWarn('classbook', 'payment open failed', { err: e })
      return NextResponse.json({ success: false, error: 'Could not start checkout. Please try again.' }, { status: 502 })
    }
  } else if (queuedRow?.id) {
    // Free booking — QSTASH.7 push delivery: nudge QStash to deliver this row to
    // the worker now instead of waiting for the next cron tick. Fire-and-forget:
    // env-gated (no QSTASH_TOKEN → skipped), and any failure leaves the row for
    // the cron — the queue table is the delivery guarantee. Dedup id is DASH-ONLY
    // (QStash 400s on colons — the QSTASH.2 lesson).
    try {
      await publishQueuePush({
        path: CLASS_BOOKINGS_WORKER_PATH,
        body: { id: queuedRow.id },
        deduplicationId: `class-booking-${queuedRow.id}`,
      })
    } catch {
      // publishQueuePush swallows its own errors; belt-and-braces only.
    }
  }

  // CAPI: a captured /start class lead is a website Lead event. The contact+
  // class-keyed event_id makes double-submits dedupe at Meta; gated on
  // settings.meta_ads.dataset_id inside the helper. Never blocks the response.
  try {
    const { sendWebsiteConversion } = await import('@/lib/meta-capi')
    await sendWebsiteConversion(db, {
      locationId, eventName: 'Lead', email: b.email, phone: b.phone,
      eventSourceUrl,
      eventId: `classlead-${contactId}-${b.event_id}`,
      contentName: chosen.name,
    })
  } catch (e) { logWarn('classbook', 'capi lead failed', { err: e }) }

  // Paid: hand the funnel the checkout details. Free: the booking is queued.
  if (paymentResponse) return NextResponse.json({ success: true, data: paymentResponse })
  return NextResponse.json({ success: true, data: { queued: true } })
}
