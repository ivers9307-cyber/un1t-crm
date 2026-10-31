// POST /api/public/trial-purchases — PAIDTRIAL.1: start a paid trial purchase
// from the /trial page. TRIALSTUDIO.6: the body names the studio
// (`stillorgan` | `hatch`); the product comes from that studio's row on the
// `trial` page (its paid_trial block, loadTrialStudios); the price is the BLOCK's (or, at
// Hatch, the mirrored un1t.online product's), never the client's. Captures the
// lead exactly as the class funnel does (contact, lead_source, attribution,
// consent, deal placement, Meta Lead) against the chosen studio, then:
//   Stillorgan (Glofox): refuses a buyer with a trial history BEFORE any row
//     or money (200 trial_used; a failed read is 503, never a refusal), else
//     inserts an `awaiting_payment` row and opens the Revolut payment. The
//     webhook or the status route releases the row to the processor once the
//     money is in.
//   Hatch Street (un1t.online): refuses an active member (200 active_member),
//     needs the un1t.online terms tick when the studio's writes are on (400
//     terms_required), inserts the row, then trial-purchase-un1t-checkout.js
//     finds or creates the un1t.online account and returns un1t.online's own
//     hosted checkout URL. The CRM never charges a Hatch buyer.
// No auth; rate-limited per landing path and IP.
//
// PAGES.1 — `page` + `studio` (a public path; `hatch` still reads as
// hatch-street): the studio's entry is built from the live page's studio row
// (trialEntryFromRow on the page's paid_trial block merged with the row's
// offer and attribution), so the plan or product, the price and the tag and
// lead source are the row's; the purchase row records `page_id`. Which
// provider sells is the studio's membership_source. Without `page` (a studio
// page's own card posts the studio key and its return path) the studio key
// names a row of the `trial` page (loadTrialStudios).
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
import { studioByKey, loadTrialStudios, trialEntryFromRow } from '@/lib/trial-studios'
import { resolvePublicPageRequest, pageRequestRefusal, studioTermsCopy, listStudioPageSlugs, publicOrgIdForHost } from '@/lib/landing-pages'
import { stillorganTrialHistory, hatchActiveMembership } from '@/lib/trial-eligibility'
import { createTrialPurchasePayment } from '@/lib/trial-purchase-payments'
import { startUn1tTrialCheckout } from '@/lib/trial-purchase-un1t-checkout'
import { normalizeTrialReturnPath } from '@/lib/trial-return-path'
import { locationCanTakePayments } from '@/lib/location-payments'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  // A page loaded before the studio choice shipped posts no studio: it was
  // the Stillorgan page, so that is the default (never a 400 for paid traffic).
  // Without `page`, a TRIAL_STUDIOS key (studioByKey judges it); with `page`
  // (PAGES.1), the studio's public path.
  studio: z.string().trim().max(40).optional(),
  page: z.string().trim().max(40).optional(),
  // TRIALFIRST.1: the page the buyer started on, so a redirect-based payment
  // returns there. Allowlisted by normalizeTrialReturnPath (/trial or a live studio
  // page's slug in the host's organisation); unknown → /trial.
  return_path: z.string().max(64).optional(),
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
  // Hatch Street only: the un1t.online terms and waiver tick, required (true)
  // when the studio's un1t.online writes are on; judged below.
  terms_accepted: z.boolean().optional(),
})

const UNAVAILABLE = 'The trial is not available right now. Please try again in a moment.'
const unavailable = (error = UNAVAILABLE) => NextResponse.json({ success: false, code: 'unavailable', error }, { status: 503 })
// A refusal is a state the page shows, not a failure: 200 with the studio's copy.
const refused = (code, error, product) => NextResponse.json({ success: false, code, error, help: { cta_label: product.helpCtaLabel } })

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data
  // PAGES.1 — the return path is /trial or a live studio page of the HOST's
  // organisation, read once per request (only when the body names one; a
  // failed read is [], so only /trial validates). Never a free-form path.
  const returnSlugs = b.return_path && b.return_path !== '/trial'
    ? await listStudioPageSlugs(db, await publicOrgIdForHost(request.headers.get('host')))
    : []
  const returnPath = normalizeTrialReturnPath(b.return_path, { slugs: returnSlugs })

  let entry
  let isHatch
  let landingPath
  let studioKey
  let pageId = null
  if (b.page) {
    // Resolved first, then limited on the RESOLVED studio path (the legacy
    // key for that studio); a request that resolves to nothing shares one
    // 'unresolved' bucket per IP.
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), page: b.page, studio: b.studio })
    const limit = await checkRateLimit(db, `trialbuy:${r.ok ? r.publicPath : 'unresolved'}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')
    const block = r.ok && r.page.offer_type === 'paid_trial'
      ? r.blocks.find((x) => x && typeof x === 'object' && x.type === 'paid_trial') || null
      : null
    if (!r.ok || !block) {
      const refusal = pageRequestRefusal(r.ok ? 'not_found' : r.reason)
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    // The row's attribution (defaults filled) is the tag and lead source;
    // the block's event_source_url default stands unless the row sets one.
    try {
      entry = await trialEntryFromRow(db, { row: r.studioRow, publicPath: r.publicPath, mergedBlock: { ...block, ...r.attribution } })
    } catch (e) {
      logError('trialbuy', 'page studio entry unreadable', { pageId: r.pageId, locationId: r.locationId, errClass: e?.name })
      return unavailable()
    }
    isHatch = entry.membershipSource === 'un1t_online'
    landingPath = r.publicPath
    studioKey = entry.key
    pageId = r.pageId
  } else {
    // No page: the studio key names a row of the trial page. A page loaded before the studio choice
    // shipped posts no studio: it was the Stillorgan page, so that is the
    // default (never a 400 for paid traffic).
    const studio = studioByKey(b.studio ?? 'stillorgan')
    if (!studio) return NextResponse.json({ success: false, code: 'unknown_studio', error: 'Unknown studio.' }, { status: 400 })
    isHatch = studio.key === 'hatch'
    landingPath = studio.publicPath
    studioKey = studio.key
    const limit = await checkRateLimit(db, `trialbuy:${landingPath}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')
    entry = (await loadTrialStudios(db)).find((s) => s.key === studio.key)
  }

  if (!entry || entry.unreadable) {
    logError('trialbuy', 'studio config unreadable', { studio: studioKey })
    return unavailable()
  }
  const product = entry.locationId ? entry.config : null
  // Each studio sells through its own provider; a block of the other shape is not for sale here.
  if (!product || product.provider !== (isHatch ? 'un1t_online' : 'glofox')) {
    if (product) logError('trialbuy', 'paid_trial block provider does not match the studio', { studio: studioKey, provider: product.provider })
    return NextResponse.json({ success: false, code: 'not_configured', error: 'The trial is not available right now.' }, { status: 400 })
  }
  const locationId = entry.locationId

  const { data: location, error: locErr } = await db.from('locations')
    .select('id, name, organization_id, settings').eq('id', locationId).maybeSingle()
  if (locErr || !location) {
    logError('trialbuy', 'location unreadable', { err: locErr, locationId })
    return unavailable()
  }
  if (!isHatch && !locationCanTakePayments(location)) {
    return NextResponse.json({ success: false, code: 'payments_unavailable', error: 'Payments are not set up for this studio yet.' }, { status: 400 })
  }

  // Hatch: with un1t.online writes off there is no account or checkout to
  // make, so nothing is for sale (refused before the lead is captured).
  const un1tWrites = isHatch && un1tWriteSettingsFrom(location.settings).writesEnabled
  if (isHatch && !un1tWrites) {
    return NextResponse.json({ success: false, code: 'not_configured', error: 'The trial is not available right now.' }, { status: 400 })
  }
  // Hatch: a new un1t.online account needs the buyer's acceptance of the
  // studio's terms and liability waiver, as the /start funnel collects it,
  // gated on writes_enabled (this is not the funnel). The tick's wording rides
  // on the refusal so the page can show it and try again.
  if (un1tWrites && b.terms_accepted !== true) {
    // The studio's own terms wording, as the page renders it (the studio
    // page's chrome.un1t_terms; a blip answers the defaults, never a refusal).
    const terms = un1tTermsPayload({ terms: await studioTermsCopy(db, locationId), studioName: location.name, publicPath: landingPath })
    return NextResponse.json({
      success: false, code: 'terms_required', error: terms.required_message,
      issues: { terms_accepted: terms.required_message }, terms,
    }, { status: 400 })
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

  // Meta Lead (the studio's own dataset), sharing the browser's event id, and
  // (TRIALCHECKOUT.1), once a checkout is open, an InitiateCheckout for the
  // same moment with the price, under `trialcheckout-<lead id>` like the
  // browser's: the Sales campaign's ad set optimises on it. A refused buyer
  // (trial_used, active_member, help_filed) was still captured, so gets the
  // Lead alone. Each is its own best-effort send.
  const { fbcFromFbclid } = await import('@/lib/meta-capi')
  const fbc = fbcFromFbclid(b.attribution?.fbclid) || undefined
  const sendConversions = async ({ initiateCheckout }) => {
    try {
      const { sendWebsiteConversion } = await import('@/lib/meta-capi')
      const leadEventId = b.lead_event_id || `triallead-${contactId}`
      const identity = {
        locationId, email, phone: b.phone,
        eventSourceUrl: product.eventSourceUrl,
        contentName: product.productName,
        fbc, clientIp: ip,
        userAgent: request.headers.get('user-agent') || undefined,
        firstName: b.first_name, lastName: b.last_name, externalId: contactId,
        fbp: b.attribution?.fbp,
      }
      await sendWebsiteConversion(db, { ...identity, eventName: 'Lead', eventId: leadEventId })
      if (!initiateCheckout) return
      try {
        await sendWebsiteConversion(db, {
          ...identity, eventName: 'InitiateCheckout', eventId: `trialcheckout-${leadEventId}`,
          value: product.priceCents / 100, currency: product.currency, contentType: 'product',
        })
      } catch (e) { logWarn('trialbuy', 'capi initiate checkout failed', { err: e }) }
    } catch (e) { logWarn('trialbuy', 'capi lead failed', { err: e }) }
  }
  const refusedWithLead = async (code, error) => {
    await sendConversions({ initiateCheckout: false })
    return refused(code, error, product)
  }

  // ── Eligibility, before any row or money ──
  let un1tContact = null
  if (isHatch) {
    const membership = await hatchActiveMembership(db, { locationId, contactId })
    if (!membership.ok) return unavailable()
    if (membership.active) return refusedWithLead('active_member', product.activeMemberText)
    const { data: c, error: cErr } = await db.from('contacts')
      .select('id, email, name, first_name, last_name, phone, un1t_user_id').eq('id', contactId).maybeSingle()
    if (cErr || !c) {
      logError('trialbuy', 'contact unreadable', { err: cErr, contactId, locationId })
      return unavailable()
    }
    un1tContact = c
  } else {
    const { data: c, error: cErr } = await db.from('contacts')
      .select('id, glofox_member_id, glofox_membership_status, glofox_membership_plan').eq('id', contactId).maybeSingle()
    if (cErr || !c) {
      logError('trialbuy', 'contact unreadable', { err: cErr, contactId, locationId })
      return unavailable()
    }
    const history = await stillorganTrialHistory(db, { locationId, contact: c })
    if (!history.ok) return unavailable()
    if (history.hadTrial) return refusedWithLead('trial_used', product.trialUsedText)
  }

  // Hatch: the acceptance, with the documents' version at the time of the
  // tick (null when they could not be read; the tick still stands).
  let termsRecord = {}
  if (un1tWrites && b.terms_accepted === true) {
    let version = null
    try { version = (await readUn1tLegalDocs(db, locationId)).version } catch (e) { logWarn('trialbuy', 'legal documents version unread', { err: e, locationId }) }
    termsRecord = { terms_accepted_at: new Date().toISOString(), terms_source: 'website', terms_version: version }
  }

  // ── The purchase row, then the provider payment (Stillorgan) or un1t.online's checkout (Hatch) ──
  const attribution = {
    ...(b.attribution || {}),
    fbc,
    event_source_url: product.eventSourceUrl,
  }
  delete attribution.fbclid
  const { data: row, error: insErr } = await db.from('trial_purchases').insert({
    ...(pageId ? { page_id: pageId } : {}),
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
    ...(isHatch ? { payment_provider: 'un1t_online', un1t_product_id: product.un1tProductId, ...termsRecord } : {}),
  }).select('*').single()
  if (insErr || !row) {
    // Ids and the code only: a PostgREST error's details can name the row (email, phone).
    logError('trialbuy', 'purchase insert failed', { code: insErr?.code ?? null, contactId })
    return NextResponse.json({ success: false, code: 'unavailable', error: 'Could not start your purchase. Please try again.' }, { status: 500 })
  }

  let payment = null
  let redirectUrl = null
  if (isHatch) {
    const outcome = await startUn1tTrialCheckout(db, { row, location, contact: un1tContact, returnPath })
    if (outcome.kind === 'unavailable') return unavailable()
    if (outcome.kind === 'help_filed') {
      await sendConversions({ initiateCheckout: false })
      return NextResponse.json({ success: false, code: 'help_filed', error: product.helpSentText })
    }
    redirectUrl = outcome.checkoutUrl
  } else {
    try {
      payment = await createTrialPurchasePayment({ db, purchase: row, location, amountCents: product.priceCents, currency: product.currency, returnPath })
    } catch (e) {
      logError('trialbuy', 'payment create failed', { err: e, purchaseId: row.id })
      return NextResponse.json({ success: false, code: 'checkout_failed', error: 'Could not start checkout. Please try again.' }, { status: 502 })
    }
  }

  await sendConversions({ initiateCheckout: true })

  // Hatch: the checkout URL goes to the browser once; it is never stored on the row or logged.
  if (isHatch) {
    return NextResponse.json({ success: true, data: {
      purchaseId: row.id,
      redirect_url: redirectUrl,
      amount_cents: product.priceCents,
      currency: product.currency,
      product_name: product.productName,
    } })
  }
  return NextResponse.json({ success: true, data: {
    purchaseId: payment.purchaseId,
    checkout: payment.checkout,
    amount_cents: product.priceCents,
    currency: product.currency,
    product_name: product.productName,
  } })
}
