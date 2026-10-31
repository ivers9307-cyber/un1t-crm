// POST /api/public/corp-claims — CORPPROMO.1: claim a /corp corporate promo.
//
// The body names the promo (a key in src/lib/corp-promos.js); the studio, the
// credits and their expiry come from the registry, never the client. Captures
// the lead the way /trial does (contact, lead source, attribution, visit
// origin, consent, deal placement, Meta Lead) against the promo's studio, then:
//   - refuses an active member (200 active_member) and anyone not eligible
//     (200 already_claimed | free_trial_used | trained, src/lib/corp-promo-eligibility.js)
//     BEFORE anything reaches un1t.online; a failed read is 503, never a refusal;
//   - needs the un1t.online terms tick (400 terms_required with its words);
//   - inserts a corp_promo_claims row, then src/lib/corp-promo-claim.js finds
//     or creates the account and grants the credits (200 granted with the
//     credits and their expiry, 200 help_filed, or 503 try again).
// Nothing is charged, ever. No auth; rate-limited per promo and IP.
//
// PAGES.1 — `page` (+ `studio`): the promo is the one the live page's studio
// row names (its merged corp_promo block's promo_key); a body `promo` is
// accepted only when it names that same promo (anything else is not_found).
// Credits and expiry still come from the registry, never a row an editor
// writes. The tag and lead source are the row's attribution when it sets
// them, else the registry's (what /corp has always written); the words and
// the studio are the page's; the claim records `page_id`. Without `page` the
// body's `promo` key names the promo and its studio page (the promo's public
// path is that page's slug): /corp's own form, same words, studio and terms.
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
import { hatchActiveMembership } from '@/lib/trial-eligibility'
import { resolveCorpPromo, corpPromoCopyFromBlocks, fillCorpPromoTokens } from '@/lib/corp-promos'
import { corpPromoEligibility } from '@/lib/corp-promo-eligibility'
import { fulfilCorpPromoClaim } from '@/lib/corp-promo-claim'
import { corpPromoTokens } from '@/lib/corp-promo-emails'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'
import { zoneOfLocation } from '@/lib/location-time'
import { logWarn, logError } from '@/lib/log'
import { resolvePublicPageRequest, pageRequestRefusal } from '@/lib/landing-pages'

export const runtime = 'nodejs'

const Schema = z.object({
  // Required without `page`; with `page` only a check against the row's promo.
  promo: z.string().trim().min(1).max(60).optional(),
  page: z.string().trim().max(40).optional(),
  studio: z.string().trim().max(40).optional(),
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50).refine(isValidMobileNumber, 'Enter a valid mobile number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick consent to continue' }),
  terms_accepted: z.boolean().optional(),
  attribution: z.object({
    utm_source: z.string().max(200).optional(),
    utm_campaign: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(),
    utm_term: z.string().max(200).optional(),
    fbclid: z.string().max(500).optional(),
    fbp: z.string().max(100).optional(),
  }).optional(),
  lead_event_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  visit: z.object({
    referrer: z.string().max(2000).optional(),
    landing_path: z.string().max(500).optional(),
  }).optional(),
}).superRefine((v, ctx) => {
  if (!v.page && !v.promo) ctx.addIssue({ code: 'custom', path: ['promo'], message: 'Required' })
})

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

const TRY_AGAIN = 'Something went wrong on our side. Please try again in a moment.'
const unavailable = () => NextResponse.json({ success: false, code: 'unavailable', error: TRY_AGAIN }, { status: 503 })
const notAvailable = (error) => NextResponse.json({ success: false, code: 'not_available', error }, { status: 400 })
// A refusal is a state the page shows, not a failure: 200 with the studio's words.
const refused = (code, error) => NextResponse.json({ success: false, code, error })

// Best-effort contact stamps: a failure is logged (ids and codes only) and never blocks the claim.
async function bestEffort(step, write) {
  try {
    const r = await write()
    if (r?.error) logWarn('corp-promo', `${step} failed`, { code: r.error.code ?? null })
  } catch (e) {
    logWarn('corp-promo', `${step} threw`, { errClass: e?.name })
  }
}

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  let promo
  let copy
  let locationId
  let terms
  let tag
  let leadSource
  let pageId = null
  if (b.page) {
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), page: b.page, studio: b.studio })
    const block = r.ok && r.page.offer_type === 'promo_credits'
      ? r.blocks.find((x) => x && typeof x === 'object' && x.type === 'corp_promo') || null
      : null
    const rowKey = str(block?.promo_key)
    // Limited on the promo the row names (the legacy key for that promo);
    // nothing resolved shares an 'unresolved' bucket per IP.
    const limit = await checkRateLimit(db, `corpclaim:${rowKey || 'unresolved'}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')
    if (!r.ok || !block || (b.promo && b.promo !== rowKey)) {
      const refusal = pageRequestRefusal(r.ok ? 'not_found' : r.reason)
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    promo = resolveCorpPromo(rowKey)
    // Only a live promo at this page's studio is for sale (the page shows the same rule).
    if (!promo || !promo.live || promo.publicPath !== r.publicPath) return notAvailable('This offer is not available right now.')
    copy = corpPromoCopyFromBlocks([block], promo.key)
    locationId = r.locationId
    pageId = r.pageId
    terms = r.terms
    const rowAttr = r.studioRow?.attribution || {}
    tag = str(rowAttr.tag) || promo.tag
    leadSource = str(rowAttr.lead_source) || promo.leadSource
  } else {
    promo = resolveCorpPromo(b.promo)
    if (!promo || !promo.live) return notAvailable('This offer is not available right now.')
    const limit = await checkRateLimit(db, `corpclaim:${promo.key}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')

    // The promo's studio and its words, from the studio page at the promo's
    // public path. A failed read is 503, never a refusal.
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), legacyPath: promo.publicPath })
    if (!r.ok && r.reason === 'unreadable') {
      logError('corp-promo', 'studio page unreadable', { promo: promo.key })
      return unavailable()
    }
    if (!r.ok) return notAvailable('This offer is not available right now.')
    copy = corpPromoCopyFromBlocks(r.blocks, promo.key)
    locationId = r.locationId
    terms = r.terms // no page_id: the claim came from the promo's own form, not the studio page
    tag = promo.tag
    leadSource = promo.leadSource
  }
  const { data: location, error: locErr } = await db.from('locations')
    .select('id, name, organization_id, settings, timezone').eq('id', locationId).maybeSingle()
  if (locErr || !location) {
    logError('corp-promo', 'location unreadable', { locationId, code: locErr?.code ?? null })
    return unavailable()
  }
  const un1t = un1tWriteSettingsFrom(location.settings)
  if (!un1t.writesEnabled) return notAvailable(copy.unavailable_text)
  const tokens = corpPromoTokens({ firstName: b.first_name, credits: promo.credits, expiresAt: null, zone: zoneOfLocation(location), studioName: location.name })
  const say = (text) => fillCorpPromoTokens(text, tokens)

  // A new un1t.online account needs the studio's terms and liability waiver.
  if (b.terms_accepted !== true) {
    const termsPayload = un1tTermsPayload({ terms, studioName: location.name, publicPath: promo.publicPath })
    return NextResponse.json({
      success: false, code: 'terms_required', error: termsPayload.required_message,
      issues: { terms_accepted: termsPayload.required_message }, terms: termsPayload,
    }, { status: 400 })
  }

  // ── Capture the lead ──
  const name = `${b.first_name} ${b.last_name}`.trim()
  const email = b.email.toLowerCase()
  const contactId = await findOrCreateRaceContact({
    db, locationId, email, name, phone: b.phone, restrictToOrg: true,
    insertFields: { source: 'corp_promo', first_name: b.first_name, last_name: b.last_name },
  })
  if (!contactId) return NextResponse.json({ success: false, code: 'capture_failed', error: 'Could not capture your details. Please try again.' }, { status: 500 })

  const nowIso = new Date().toISOString()
  await bestEffort('first/last stamp', () => db.from('contacts').update({ first_name: b.first_name, last_name: b.last_name }).eq('id', contactId).is('first_name', null))
  await bestEffort('lead_source stamp', () => db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null))
  await bestEffort('last_lead_source stamp', () => db.from('contacts').update({ last_lead_source: leadSource, last_lead_source_at: nowIso }).eq('id', contactId))
  const a = b.attribution || {}
  const utm = {}
  for (const k of ['utm_campaign', 'utm_content', 'utm_term']) if (a[k]) utm[k] = String(a[k])
  if (Object.keys(utm).length) {
    await bestEffort('utm stamp', () => db.from('contacts').update({ ...utm, attributed_at: nowIso }).eq('id', contactId).is('utm_campaign', null))
  }
  const v = sanitiseVisitOrigin(b.visit)
  if (v) {
    await bestEffort('visit origin stamp', () => db.from('contacts')
      .update({ visit_referrer: v.referrer, visit_landing_path: v.landing_path, visit_captured_at: nowIso })
      .eq('id', contactId).is('visit_captured_at', null))
  }
  await bestEffort('tag', () => writeContactTag(db, { contactId, locationId, tag }))
  await bestEffort('consent', async () => {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    return applyFormMarketingConsent(db, { contactId, consent: true, source: 'corp_promo', ipAddress: ip, locationId })
  })
  await bestEffort('deal placement', () => placeWaitlistEntry(db, { contactId, locationId, title: b.first_name || 'Corporate promo' }))
  await bestEffort('meta lead', async () => {
    const { sendWebsiteConversion, fbcFromFbclid } = await import('@/lib/meta-capi')
    return sendWebsiteConversion(db, {
      locationId, email, phone: b.phone, eventName: 'Lead', eventId: b.lead_event_id || `corplead-${contactId}`,
      contentName: promo.key, fbc: fbcFromFbclid(a.fbclid) || undefined, fbp: a.fbp, clientIp: ip,
      userAgent: request.headers.get('user-agent') || undefined,
      firstName: b.first_name, lastName: b.last_name, externalId: contactId,
    })
  })

  // ── Who may claim, before anything reaches un1t.online ──
  const membership = await hatchActiveMembership(db, { locationId, contactId })
  if (!membership.ok) return unavailable()
  if (membership.active) return refused('active_member', say(copy.active_member_text))
  const elig = await corpPromoEligibility(db, {
    locationId, organizationId: location.organization_id ?? null, contactId, email, phone: b.phone,
    trialProductId: un1t.trialProductId, promoKey: promo.key,
  })
  if (!elig.ok) return unavailable()
  const refusalText = { already_claimed: copy.already_claimed_text, free_trial_used: copy.trial_used_text, trained: copy.trained_text }
  if (!elig.eligible) return refused(elig.reason, say(refusalText[elig.reason] || copy.trained_text))

  const { data: contact, error: cErr } = await db.from('contacts')
    .select('id, email, name, first_name, last_name, phone, un1t_user_id').eq('id', contactId).maybeSingle()
  if (cErr || !contact) {
    logError('corp-promo', 'contact unreadable', { contactId, locationId, code: cErr?.code ?? null })
    return unavailable()
  }

  let version = null
  try { version = (await readUn1tLegalDocs(db, locationId)).version } catch (e) { logWarn('corp-promo', 'legal documents version unread', { locationId, errClass: e?.name }) }
  const { data: claim, error: insErr } = await db.from('corp_promo_claims').insert({
    ...(pageId ? { page_id: pageId } : {}),
    location_id: locationId,
    contact_id: contactId,
    promo_key: promo.key,
    first_name: b.first_name,
    last_name: b.last_name,
    customer_email: email,
    customer_phone: b.phone,
    status: 'processing',
    terms_accepted_at: nowIso,
    terms_source: 'website',
    terms_version: version,
    attribution: { ...utm, ...(a.utm_source ? { utm_source: String(a.utm_source) } : {}) },
    lead_event_id: b.lead_event_id || null,
  }).select('*').single()
  if (insErr || !claim) {
    // Ids and the code only: a PostgREST error's details can name the row.
    logError('corp-promo', 'claim insert failed', { contactId, code: insErr?.code ?? null })
    return unavailable()
  }

  const outcome = await fulfilCorpPromoClaim(db, {
    claim, location, contact, promo, copy, zone: zoneOfLocation(location), trialProductId: un1t.trialProductId,
  })
  if (outcome.kind === 'unavailable') return unavailable()
  if (outcome.kind === 'help_filed') return refused('help_filed', say(copy.help_text))
  if (outcome.kind === 'ineligible') return refused(outcome.reason, say(refusalText[outcome.reason] || copy.trained_text))
  const done = corpPromoTokens({ firstName: b.first_name, credits: outcome.credits, expiresAt: outcome.expiresAt, zone: zoneOfLocation(location), studioName: location.name })
  return NextResponse.json({ success: true, data: {
    credits: outcome.credits,
    expires_at: outcome.expiresAt,
    title: fillCorpPromoTokens(copy.done_title, done),
    message: fillCorpPromoTokens(copy.done_body, done),
  } })
}
