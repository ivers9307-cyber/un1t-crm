// POST /api/public/class-booking — public enqueue for the ClassFunnel block /
// /start wizard's class path. Location resolved from the body `path`
// (public_path; defaults to 'stillorgan'); the chosen class is re-validated
// against that location's live bookable list.
// Captures the lead in the CRM (contact + new_lead deal + lead_source +
// tag = "reclassify as a fresh lead") then enqueues a class_booking_requests
// row for the process-class-bookings cron. Returns instantly; the booking +
// WhatsApp confirmation happen async. No auth; rate-limited.
//
// PAGES.1 — `page` (+ `studio`, optional on a one-studio page): the live
// page's offer block merged with its studio row decides the trial pair, the
// allow-listed validation read and (from the row's `attribution`) the tag,
// lead source and CAPI eventSourceUrl; `path` and `campaign` are ignored and
// the body can never set any of them. The queued row records `page_id`.
// Without `page`, `path` names a STUDIO PAGE by its slug (/stillorgan's own
// class funnel): its merged class_funnel block decides everything the same way.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { sanitiseVisitOrigin } from '@/lib/visit-origin'
import { writeContactTag } from '@/lib/contact-tags'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { logWarn, logError } from '@/lib/log'
import { placeWaitlistEntry } from '@/lib/waitlist-entry'
import { placeContactNow } from '@/lib/pipeline-place-now'
import { resolveLandingPath, classFunnelConfigFromBlocks, classFunnelTimetableUnavailableMessage } from '@/lib/public-landing'
import { resolveCampaignKey, campaignFunnelBlock, campaignFunnelConfig, campaignFunnelCopy } from '@/lib/campaign-funnel'
import { createClassBookingPayment } from '@/lib/class-booking-payments'
import { locationCanTakePayments } from '@/lib/location-payments'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'
import { resolvePublicPageRequest, pageRequestRefusal } from '@/lib/landing-pages'
import { offerConfigured } from '@/lib/landing-page-offers'

export const runtime = 'nodejs'

const Schema = z.object({
  event_id: z.string().trim().min(1).max(64),
  path: z.string().trim().max(64).optional(),
  // FIFTYPLUS.1 — a campaign page (/50plus): the row's campaign_funnel block
  // for this key decides the tag, lead source, trial pair and the allow-listed
  // validation read. Judged below, after the row is read.
  campaign: z.string().trim().max(64).optional(),
  // PAGES.1 — the page (slug) and studio (public path) the form is on.
  page: z.string().trim().max(40).optional(),
  studio: z.string().trim().max(40).optional(),
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
    // METADATASET.1 — the ad click id off the landing URL. Never stored: it
    // only rides on the Lead event sent to Meta below.
    fbclid: z.string().max(500).optional(),
    // MATCHQUALITY.1 — the Pixel's browser id cookie, when consent let it set.
    fbp: z.string().max(100).optional(),
  }).optional(),
  // BROWSERLEAD.1 — the id the browser's Pixel Lead will carry, so the CAPI
  // Lead below shares it and Meta dedupes the pair. Opaque, shape-checked.
  lead_event_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  // VISIT-ORIGIN.1 — first page of the visit + its referrer. Low-trust;
  // sanitiseVisitOrigin reduces it before anything is stored.
  visit: z.object({
    referrer: z.string().max(2000).optional(),
    landing_path: z.string().max(500).optional(),
  }).optional(),
  // UN1TWRITE.18 — the un1t.online terms and waiver tick. Required (true)
  // only at a un1t.online studio with the funnel on; judged below, after
  // the studio is known.
  terms_accepted: z.boolean().optional(),
})

// One source for everything the handler reads off the row: the class_funnel
// block (no campaign) or the campaign_funnel block for the key.
function resolveFunnel(blocks, landingPath, campaignKey) {
  if (!campaignKey) {
    return {
      ...classFunnelConfigFromBlocks(blocks, landingPath),
      allowKeywords: null,
      timetableUnavailableText: classFunnelTimetableUnavailableMessage(blocks),
      notConfigured: false,
    }
  }
  const block = campaignFunnelBlock(blocks, campaignKey)
  const cfg = campaignFunnelConfig(block, { landingPath })
  const copy = campaignFunnelCopy(block || {})
  return {
    tag: cfg.tag, leadSource: cfg.leadSource, eventSourceUrl: cfg.eventSourceUrl,
    trialMembershipId: cfg.trialMembershipId, trialPlanCode: cfg.trialPlanCode,
    priceCents: 0, currency: 'EUR',
    allowKeywords: cfg.allowKeywords,
    timetableUnavailableText: copy.timetable_unavailable_text,
    notConfigured: !block || !cfg.configured,
    notConfiguredText: copy.not_configured_text,
  }
}

// PAGES.1 — the same shape from a resolved page: its merged offer block, its
// studio row's attribution. Only a class offer books a class here.
const isObj = (x) => Boolean(x) && typeof x === 'object'
function resolvePageFunnel(r) {
  const landingPath = r.publicPath
  const a = r.attribution
  if (r.page.offer_type === 'one_class') {
    const block = r.blocks.find((x) => isObj(x) && x.type === 'campaign_funnel') || null
    const cfg = campaignFunnelConfig(block, { landingPath })
    const copy = campaignFunnelCopy(block || {})
    return {
      tag: a.tag || cfg.tag, leadSource: a.lead_source || cfg.leadSource, eventSourceUrl: a.event_source_url || cfg.eventSourceUrl,
      trialMembershipId: cfg.trialMembershipId, trialPlanCode: cfg.trialPlanCode,
      priceCents: 0, currency: 'EUR',
      allowKeywords: cfg.allowKeywords,
      timetableUnavailableText: copy.timetable_unavailable_text,
      notConfigured: !block || !offerConfigured('campaign_funnel', block, { landingPath }),
      notConfiguredText: copy.not_configured_text,
    }
  }
  if (r.page.offer_type === 'class_funnel') {
    const cfg = classFunnelConfigFromBlocks(r.blocks, landingPath)
    return {
      ...cfg,
      // A studio page's attribution holds only the row's own values: a blank
      // key keeps the class funnel's default (the pre-PAGES.1 value, spec §9).
      tag: a.tag || cfg.tag, leadSource: a.lead_source || cfg.leadSource, eventSourceUrl: a.event_source_url || cfg.eventSourceUrl,
      allowKeywords: null,
      timetableUnavailableText: classFunnelTimetableUnavailableMessage(r.blocks),
      notConfigured: false,
    }
  }
  return null
}

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  // Body is validated FIRST (pure, no DB) so the landing path is known before
  // the limiter — a malformed body 400s without consuming any tenant's window.
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  let landingPath
  let locationId
  let pageId = null
  let terms
  let pageBlocks
  let funnel
  if (b.page) {
    // PAGES.1 — resolved first, then limited on the RESOLVED studio path (the
    // legacy key for that studio); a request that resolves to nothing shares
    // one 'unresolved' bucket per IP.
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), page: b.page, studio: b.studio })
    const limit = await checkRateLimit(db, `classbook:${r.ok ? r.publicPath : 'unresolved'}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')
    if (!r.ok) {
      const refusal = pageRequestRefusal(r.reason)
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    funnel = resolvePageFunnel(r)
    if (!funnel) {
      const refusal = pageRequestRefusal('not_found')
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    landingPath = r.publicPath
    locationId = r.locationId
    pageId = r.pageId
    terms = r.terms
    pageBlocks = r.blocks
  } else {
    landingPath = resolveLandingPath(b.path)
    // SAAS-6: tenant-keyed by the RESOLVED landing path so one location's booking
    // traffic can't exhaust another's window for the same IP.
    const limit = await checkRateLimit(db, `classbook:${landingPath}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')

    // The studio page the path names. A miss is "not available", as it
    // always was; a failed read is 503, never a refusal.
    const legacy = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), legacyPath: landingPath })
    if (!legacy.ok && legacy.reason === 'unreadable') {
      const refusal = pageRequestRefusal('unreadable')
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    if (!legacy.ok) {
      return NextResponse.json({ success: false, error: 'Class booking is not available right now.' }, { status: 400 })
    }
    locationId = legacy.locationId
    pageId = legacy.pageId
    terms = legacy.terms
    pageBlocks = legacy.blocks
    funnel = resolveFunnel(legacy.blocks, landingPath, resolveCampaignKey(b.campaign))
  }
  const name = `${b.first_name} ${b.last_name}`.trim()
  // Nurture tag / lead_source / CAPI eventSourceUrl are DERIVED from this
  // location's class_funnel block (defaults reproduce today's Stillorgan
  // values) — never Stillorgan literals, so a second gym on this block isn't
  // mistagged 'stillorgan-start' or misreported to Meta as /start.
  //
  // FIFTYPLUS.1 — with `campaign`, they come from the row's campaign_funnel
  // block for that key instead, and the trial pair is REQUIRED: a block with
  // no plan picked, or no such block, is refused here, before any read or
  // capture, never a fallback to the class_funnel trial (the generic one).
  // A campaign booking is always free and validates against the block's
  // allow-list, so a real class outside it is class_unavailable.
  if (funnel.notConfigured) {
    return NextResponse.json({ success: false, code: 'not_configured', error: funnel.notConfiguredText }, { status: 409 })
  }
  const { tag, leadSource, eventSourceUrl, trialMembershipId, trialPlanCode, priceCents, currency } = funnel

  // UN1TWRITE.18 — at a un1t.online studio with the funnel on, the person
  // must accept the studio's terms and liability waiver; the acceptance is
  // recorded on the queue row (the create-account step copies it onto the
  // ledger). An unreadable settings row never blocks a booking: the request
  // is queued with no acceptance, and the processor (which reads the
  // settings again) never creates an account without one.
  let un1tFunnel = false
  let un1tStudioName = null
  try {
    const un1t = await readUn1tWriteSettings(db, locationId)
    un1tFunnel = un1t.membershipSource === 'un1t_online' && un1t.settings.funnelEnabled
    un1tStudioName = un1t.studioName
  } catch (e) {
    logWarn('classbook', 'un1t.online settings unreadable; terms not judged', { locationId, err: e })
  }
  if (un1tFunnel && b.terms_accepted !== true) {
    // The tick's wording rides on the refusal, so a page that loaded before
    // the funnel switched on (or whose class list read missed it) can show
    // the tick and try again instead of being refused with nothing to tick.
    // The studio's own terms wording (the resolver's `terms`).
    const termsPayload = un1tTermsPayload({ terms, studioName: un1tStudioName, publicPath: landingPath })
    return NextResponse.json({
      success: false, code: 'terms_required', error: termsPayload.required_message,
      issues: { terms_accepted: termsPayload.required_message }, terms: termsPayload,
    }, { status: 400 })
  }

  // Paid intro? Load the location's payment settings so we can resolve the rail.
  // `wantsPayment` gates the paid branch; `paid` is only true once we've also
  // confirmed the location can actually charge (Revolut always; Stripe needs a
  // connected account).
  const wantsPayment = Number.isFinite(priceCents) && priceCents > 0
  let locationForPay = null
  if (wantsPayment) {
    const { data: loc } = await db.from('locations').select('id, settings, membership_source').eq('id', locationId).maybeSingle()
    locationForPay = loc || null
  }
  // UN1TWRITE.18 — no paid intro at a un1t.online studio: anything paid there
  // goes through un1t.online checkout, and the editor refuses to save a price.
  // A price stored before that guard is ignored (the free path), loudly.
  const un1tStudio = locationForPay?.membership_source === 'un1t_online'
  if (wantsPayment && un1tStudio) {
    logError('classbook', 'class_funnel price ignored at a un1t.online studio', { locationId })
  }
  const paid = wantsPayment && !un1tStudio && locationCanTakePayments(locationForPay)

  // Validate the chosen class against the live bookable list — never trust the
  // client's event_id / class_name / starts_at. We use the SERVER's name + start
  // for storage so spoofed text can't reach Glofox, /approvals or the WhatsApp
  // confirmation, and an event_id not in the list is rejected (don't capture a
  // lead for a class that can't be booked).
  const { readPublicClasses } = await import('@/lib/public-classes')
  let chosen = null
  let timetableErr = null
  try {
    const r = funnel.allowKeywords
      ? await readPublicClasses(db, locationId, 14, { allowKeywords: funnel.allowKeywords, blocks: pageBlocks })
      : await readPublicClasses(db, locationId, 14, { blocks: pageBlocks })
    timetableErr = r.error
    chosen = r.classes.find((c) => c.event_id === b.event_id) || null
  } catch (e) {
    logWarn('classbook', 'class validate failed', { err: e })
    timetableErr = 'validate_threw'
  }
  if (timetableErr) {
    // REGISTRYREAD.1a: a timetable we could not read is not "that class is
    // gone". class_unavailable told the customer it "filled up while you were
    // typing" and sent them to an empty picker. The funnel shows this error
    // and keeps what they typed. The words are the operator's (the
    // class_funnel block's timetable_unavailable_message), default otherwise.
    logWarn('classbook', 'timetable unreadable', { locationId, error: timetableErr })
    return NextResponse.json({
      success: false,
      code: 'timetable_unavailable',
      error: funnel.timetableUnavailableText,
    }, { status: 503 })
  }
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
  // Sibling locations in the same org are fine — and necessary: a Stillorgan
  // member booking at Hatch is one person. (Under mig 008's global
  // `contacts_email_unique` a location-only match also left a known email
  // unable to insert, 23505 → 500; since W0.6, mig 712, the index is per
  // organisation and org scope is the helper's default.)
  // SOURCE-LABEL.1 — the helper's INSERT defaults to the race shape
  // (source 'race_signup'), which is wrong for a class-booking lead and
  // made every Hatch ad lead look like a race entrant in the contacts
  // list. insertFields applies on CREATE only; a matched contact keeps
  // whatever source it already has.
  const contactId = await findOrCreateRaceContact({ db, locationId, email: b.email.toLowerCase(), name, phone: b.phone, restrictToOrg: true, insertFields: { source: 'class_booking' } })
  if (!contactId) return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })

  try { await db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null) } catch (e) { logWarn('classbook', 'lead_source failed', { err: e }) }
  // FUNNEL.5 — LAST-touch alongside first-touch. The line above is
  // stamp-if-null and therefore permanent, so nothing recorded that this
  // contact came back, or through what. Stamped unconditionally, and
  // best-effort: losing it must never cost the booking.
  try {
    await db.from('contacts')
      .update({ last_lead_source: leadSource, last_lead_source_at: new Date().toISOString() })
      .eq('id', contactId)
  } catch (e) { logWarn('classbook', 'last_lead_source failed', { err: e }) }
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
  // VISIT-ORIGIN.1 — first touch, stamp-if-null, best-effort. Stamped for
  // organic visitors too: that is the whole point (an ad lead already has
  // ad_provider; the label helper lets the ad win).
  try {
    const v = sanitiseVisitOrigin(b.visit)
    if (v) {
      await db.from('contacts')
        .update({ visit_referrer: v.referrer, visit_landing_path: v.landing_path, visit_captured_at: new Date().toISOString() })
        .eq('id', contactId)
        .is('visit_captured_at', null)
    }
  } catch (e) { logWarn('attribution', 'visit origin failed', { err: e }) }
  try { await writeContactTag(db, { contactId, locationId, tag }) } catch (e) { logWarn('classbook', 'tag failed', { err: e }) }
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'start_class', ipAddress: ip, locationId })
  } catch (e) { logWarn('classbook', 'consent failed', { err: e }) }
  // Open (or re-open) this lead's place on the studio's primary board.
  // Best-effort — losing the deal must never cost the booking. Same helper as
  // the website lead form, which is where the reasoning for each line of the
  // placement and for the manual-board re-signup bump lives (WAITLIST.4).
  try {
    await placeWaitlistEntry(db, {
      contactId,
      locationId,
      title: b.first_name || 'Class lead',
    })
  } catch (e) { logWarn('classbook', 'deal placement failed', { err: e }) }
  // PIPE3.7 — a programme lead (the /50plus page) belongs on the Programmes
  // board from the moment they land, not after tonight's run: route them now.
  // Best-effort; the nightly pass converges either way.
  try {
    const placed = await placeContactNow(db, { locationId, contactId })
    if (!placed.ok) logWarn('classbook', 'board placement skipped', { reason: placed.reason })
  } catch (e) { logWarn('classbook', 'board placement failed', { err: e }) }

  // UN1TWRITE.18 — the acceptance, with the documents' version at the time of
  // the tick (null when they could not be read; the tick still stands).
  let termsRecord = {}
  if (un1tFunnel && b.terms_accepted === true) {
    let version = null
    try { version = (await readUn1tLegalDocs(db, locationId)).version } catch (e) { logWarn('classbook', 'legal documents version unread', { err: e }) }
    termsRecord = { terms_accepted_at: new Date().toISOString(), terms_source: 'website', terms_version: version }
  }

  // Dedupe: if this contact already has an active/booked request for this class
  // (double-submit, refresh, retry), don't create a second. Treat as success.
  // `awaiting_payment` is included so a double-submit of a PAID booking doesn't
  // open a second provider order; a failed/expired payment (`payment_failed`) is
  // deliberately NOT included so the customer can retry checkout.
  try {
    const { data: existing } = await db.from('class_booking_requests')
      .select('id').eq('contact_id', contactId).eq('glofox_event_id', b.event_id)
      .in('status', ['queued', 'processing', 'booked', 'awaiting_payment']).limit(1).maybeSingle()
    if (existing) {
      // A retry that now carries the tick records it on the row the first
      // try queued without one (never over an acceptance already there).
      if (termsRecord.terms_source) {
        try {
          const { error: termsErr } = await db.from('class_booking_requests').update(termsRecord)
            .eq('id', existing.id).is('terms_accepted_at', null)
          if (termsErr) logWarn('classbook', 'terms record on the deduped row failed', { err: termsErr })
        } catch (e) { logWarn('classbook', 'terms record on the deduped row failed', { err: e }) }
      }
      return NextResponse.json({ success: true, data: { queued: true, deduped: true } })
    }
  } catch (e) { logWarn('classbook', 'dedupe check failed', { err: e }) }

  // class_name + starts_at come from the SERVER-validated class, not the client.
  const { data: queuedRow, error: insErr } = await db.from('class_booking_requests').insert({
    ...termsRecord,
    ...(pageId ? { page_id: pageId } : {}),
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
        request: { id: queuedRow.id, location_id: locationId, class_name: queuedRow.class_name, customer_name: name, customer_email: b.email.toLowerCase() },
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
    const { sendWebsiteConversion, fbcFromFbclid } = await import('@/lib/meta-capi')
    await sendWebsiteConversion(db, {
      locationId, eventName: 'Lead', email: b.email, phone: b.phone,
      eventSourceUrl,
      // BROWSERLEAD.1 — the browser's id when it sent one (dedupe with the
      // Pixel's Lead); the old contact+class key otherwise.
      eventId: b.lead_event_id || `classlead-${contactId}-${b.event_id}`,
      contentName: chosen.name,
      // METADATASET.1 — what lets Meta credit this lead to the ad click.
      fbc: fbcFromFbclid(b.attribution?.fbclid),
      clientIp: ip,
      userAgent: request.headers.get('user-agent') || undefined,
      // MATCHQUALITY.1 — name, our contact id and the browser id cookie.
      firstName: b.first_name, lastName: b.last_name, externalId: contactId,
      fbp: b.attribution?.fbp,
    })
  } catch (e) { logWarn('classbook', 'capi lead failed', { err: e }) }

  // Paid: hand the funnel the checkout details. Free: the booking is queued.
  if (paymentResponse) return NextResponse.json({ success: true, data: paymentResponse })
  return NextResponse.json({ success: true, data: { queued: true } })
}
