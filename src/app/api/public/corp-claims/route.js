// POST /api/public/corp-claims — CORPPROMO.1: claim a /corp corporate promo.
//
// The body names the promo; the studio, the credits and their expiry come from
// that studio's corp_promos row (WAYSIN.3, mig 816), never the client. Captures
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
// Credits and expiry come from the studio's corp_promos row, never the
// landing row. The tag and lead source are the landing row's attribution when
// it sets them, else the promo's (what /corp has always written); the words
// and the studio are the page's; the claim records `page_id`. Without `page`
// the body's `promo` key is a SEED key (CORP_PROMO_SEEDS): its public path
// names the studio page (/corp's own form, same words, studio and terms) and
// the promo is that studio's row by that key.
//
// WAYSIN.3 — the promo is ALWAYS read at the resolved studio's location_id
// (readCorpPromo is location-scoped), never by key alone: a key another
// studio holds is not available here. A failed read is 503 with nothing
// written; a Glofox promo with no plan binding is 409 glofox_plan_missing
// before any Glofox call; every claim row records the promo's platform.
import { cleanAttribution } from '@/lib/campaign-funnel-attribution'
import { stampFirstTouchSource } from '@/lib/contact-first-touch-source'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContactWithOutcome } from '@/lib/race-contact-linking'
import { applyOfferFormConsent } from '@/lib/offer-form-consent'
import { sanitiseVisitOrigin } from '@/lib/visit-origin'
import { writeContactTag } from '@/lib/contact-tags'
import { fillMissingContactNames } from '@/lib/contact-name-fill'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { placeWaitlistEntry } from '@/lib/waitlist-entry'
import { hatchActiveMembership } from '@/lib/trial-eligibility'
import { CORP_PROMO_SEEDS, corpPromoCopyFromBlocks, fillCorpPromoTokens } from '@/lib/corp-promos'
import { readCorpPromo, listCorpPromos } from '@/lib/corp-promos-db'
import { corpPromoEligibility } from '@/lib/corp-promo-eligibility'
import { fulfilCorpPromoClaim } from '@/lib/corp-promo-claim'
import { corpPromoTokens } from '@/lib/corp-promo-emails'
import { glofoxPlanForPromo } from '@/lib/corp-promo-glofox-plans'
import { glofoxCorpPromoEligibility } from '@/lib/corp-promo-eligibility-glofox'
import { fulfilGlofoxCorpPromoClaim } from '@/lib/corp-promo-claim-glofox'
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'
import { zoneOfLocation, dayStrIn } from '@/lib/location-time'
import { readPromoCreditLastDay } from '@/lib/glofox-credit-window'
import { logWarn, logError } from '@/lib/log'
import { resolvePublicPageRequest, pageRequestRefusal } from '@/lib/landing-pages'
import { resolveChosenClass, classColumnsFor, chosenClassRefusal } from '@/lib/class-first-choice'
import { classFirstStepCopy } from '@/lib/class-first-funnel'
import { isOpenWeek } from '@/lib/open-week'
import { resolveOpenWeekPicks, insertClaimClasses } from '@/lib/open-week-claim'

export const runtime = 'nodejs'

const Schema = z.object({
  // Required without `page`; with `page` only a check against the row's promo.
  promo: z.string().trim().min(1).max(60).optional(),
  page: z.string().trim().max(40).optional(),
  studio: z.string().trim().max(40).optional(),
  // CLASSFIRST.1 — the class the claimant picked before their details (the
  // studio's event id, judged below against the picker's own read).
  event_id: z.string().trim().min(1).max(64).optional(),
  // OPENWEEK.1 — the classes an open week claimant picked (judged below
  // against the studio's own read, the window and the limits).
  event_ids: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50).refine(isValidMobileNumber, 'Enter a valid mobile number'),
  // MOBILEFUNNEL.1 — optional, unticked by default (src/lib/offer-form-consent.js).
  consent: z.boolean().optional(),
  terms_accepted: z.boolean().optional(),
  attribution: z.object({
    utm_source: z.string().max(200).optional(),
    utm_medium: z.string().max(200).optional(),
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

// OPENWEEK.1 — the words for a refused set of picks (the page enforces the
// same limits, so a visitor only meets these if the page and server disagree).
const OPEN_WEEK_PICK_TEXT = Object.freeze({
  none_picked: 'Pick at least one class.',
  too_many: 'That is more classes than Open Week allows. Please remove one.',
  two_on_one_day: 'You can book one class a day. Please pick a different day for one of them.',
})

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

const TRY_AGAIN = 'Something went wrong on our side. Please try again in a moment.'
const unavailable = () => NextResponse.json({ success: false, code: 'unavailable', error: TRY_AGAIN }, { status: 503 })
const notAvailable = (error) => NextResponse.json({ success: false, code: 'not_available', error }, { status: 400 })
// A Glofox promo whose row carries no plan binding cannot grant: refused before any Glofox call.
const planMissing = (error) => NextResponse.json({ success: false, code: 'glofox_plan_missing', error }, { status: 409 })
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
  // TRIALLEAK.1 — an unfilled Meta macro in an ad value is no value.
  const b = { ...validation.data, attribution: cleanAttribution(validation.data.attribution) }

  let promo
  let copy
  let locationId
  let publicPath
  let terms
  let tag
  let leadSource
  let pageId = null
  let pageBlocks = []
  let promoBlock = null
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
    // Only a live promo of THIS studio is for sale (the page shows the same rule).
    const read = await readCorpPromo(db, { locationId: r.locationId, key: rowKey })
    if (!read.ok) {
      logError('corp-promo', 'promo unreadable', { locationId: r.locationId, promo: rowKey })
      return unavailable()
    }
    promo = read.promo
    if (!promo || !promo.live) return notAvailable('This offer is not available right now.')
    copy = corpPromoCopyFromBlocks([block], promo.key, { platform: promo.platform, kind: promo.kind })
    locationId = r.locationId
    publicPath = r.publicPath
    pageId = r.pageId
    terms = r.terms
    pageBlocks = r.blocks
    promoBlock = block
    const rowAttr = r.studioRow?.attribution || {}
    tag = str(rowAttr.tag) || promo.tag
    leadSource = str(rowAttr.lead_source) || promo.leadSource
  } else {
    // The legacy form names a seed key; the seed's public path finds its studio.
    const seed = Object.hasOwn(CORP_PROMO_SEEDS, b.promo) ? CORP_PROMO_SEEDS[b.promo] : null
    if (!seed) return notAvailable('This offer is not available right now.')
    const limit = await checkRateLimit(db, `corpclaim:${seed.key}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')

    // The promo's studio and its words, from the studio page at the seed's
    // public path. A failed read is 503, never a refusal.
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), legacyPath: seed.publicPath })
    if (!r.ok && r.reason === 'unreadable') {
      logError('corp-promo', 'studio page unreadable', { promo: seed.key })
      return unavailable()
    }
    if (!r.ok) return notAvailable('This offer is not available right now.')
    // The promo is that studio's row by the key: never another studio's.
    const read = await readCorpPromo(db, { locationId: r.locationId, key: seed.key })
    if (!read.ok) {
      logError('corp-promo', 'promo unreadable', { locationId: r.locationId, promo: seed.key })
      return unavailable()
    }
    promo = read.promo
    if (!promo || !promo.live) return notAvailable('This offer is not available right now.')
    copy = corpPromoCopyFromBlocks(r.blocks, promo.key, { platform: promo.platform })
    locationId = r.locationId
    publicPath = r.publicPath
    terms = r.terms // no page_id: the claim came from the promo's own form, not the studio page
    pageBlocks = r.blocks
    promoBlock = r.blocks.find((x) => x && typeof x === 'object' && x.type === 'corp_promo') || null
    tag = promo.tag
    leadSource = promo.leadSource
  }
  const { data: location, error: locErr } = await db.from('locations')
    .select('id, name, organization_id, settings, timezone').eq('id', locationId).maybeSingle()
  if (locErr || !location) {
    logError('corp-promo', 'location unreadable', { locationId, code: locErr?.code ?? null })
    return unavailable()
  }
  // NEWSTART.1: a Glofox promo runs on the studio's Glofox account, not un1t.online.
  const isGlofox = promo.platform === 'glofox'
  let un1t = null
  if (isGlofox) {
    // No plan binding on the row: nothing can be granted. Before any write or Glofox call.
    if (!glofoxPlanForPromo(promo)) {
      logWarn('corp-promo', 'glofox promo has no plan binding', { locationId, promo: promo.key })
      return planMissing(copy.unavailable_text)
    }
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (creds?.readError) {
      logError('corp-promo', 'glofox credentials unreadable', { locationId })
      return unavailable()
    }
    if (missingGlofoxCredentialsForLocation(creds).length > 0) return notAvailable(copy.unavailable_text)
  } else {
    un1t = un1tWriteSettingsFrom(location.settings)
    if (!un1t.writesEnabled) return notAvailable(copy.unavailable_text)
  }
  const openWeek = isOpenWeek(promo)
  const tokens = { ...corpPromoTokens({ firstName: b.first_name, credits: promo.credits, expiresAt: null, zone: zoneOfLocation(location), studioName: location.name }), max_classes: promo.maxClasses ?? '' }
  const say = (text) => fillCorpPromoTokens(text, tokens)

  // A new un1t.online account needs the studio's terms and liability waiver.
  if (!isGlofox && b.terms_accepted !== true) {
    const termsPayload = un1tTermsPayload({ terms, studioName: location.name, publicPath })
    return NextResponse.json({
      success: false, code: 'terms_required', error: termsPayload.required_message,
      issues: { terms_accepted: termsPayload.required_message }, terms: termsPayload,
    }, { status: 400 })
  }

  // CLASSFIRST.1 — the class they picked, judged by the server against the
  // same read the picker used, before the lead or the row: a class that
  // filled is class_unavailable (the card returns to the tiles), an
  // unreadable timetable is 503 in the block's words. No event_id is "no
  // class yet": the claim still grants.
  // OPENWEEK.1 — an open week takes several classes instead: the picks,
  // judged the same way (the studio's read, limited to the window), with the
  // window and the limits on top. Nothing is captured for a refused set.
  let picks = []
  let choice = { ok: true, chosen: null }
  if (openWeek) {
    const judged = await resolveOpenWeekPicks(db, { locationId, blocks: pageBlocks, promo, zone: zoneOfLocation(location), eventIds: b.event_ids || [] })
    if (!judged.ok) {
      if (judged.code === 'over') return refused('over', say(copy.over_text))
      if (judged.code === 'timetable_unavailable') {
        const refusal = chosenClassRefusal('timetable_unavailable', { timetable_unavailable: classFirstStepCopy(promoBlock, 'corp_promo').timetable_unavailable_text })
        return NextResponse.json(refusal.body, { status: refusal.status })
      }
      if (judged.code === 'class_unavailable') {
        const refusal = chosenClassRefusal('class_unavailable')
        return NextResponse.json({ ...refusal.body, event_id: judged.eventId ?? null }, { status: refusal.status })
      }
      return NextResponse.json({ success: false, code: judged.code, error: OPEN_WEEK_PICK_TEXT[judged.code] || OPEN_WEEK_PICK_TEXT.none_picked }, { status: 400 })
    }
    picks = judged.picks
  } else {
    choice = await resolveChosenClass(db, { locationId, blocks: pageBlocks, eventId: b.event_id })
    if (!choice.ok) {
      const refusal = chosenClassRefusal(choice.code, { timetable_unavailable: classFirstStepCopy(promoBlock, 'corp_promo').timetable_unavailable_text })
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    // CREDITWINDOW.1 — a class the Glofox plan's credits expire before would
    // be refused by Glofox after the grant (YOU_HAVE_NO_CREDITS_LEFT with
    // credits showing). The page does not list it; refuse it here the same
    // way, before the lead or the row. An unknown window refuses nothing.
    if (isGlofox && choice.chosen?.starts_at) {
      const zone = zoneOfLocation(location)
      const lastDay = await readPromoCreditLastDay(db, { locationId, promo, zone })
      if (lastDay && dayStrIn(new Date(choice.chosen.starts_at), zone) > lastDay) {
        const refusal = chosenClassRefusal('class_unavailable')
        return NextResponse.json(refusal.body, { status: refusal.status })
      }
    }
  }

  // ── Capture the lead ──
  const name = `${b.first_name} ${b.last_name}`.trim()
  const email = b.email.toLowerCase()
  const { contactId, created: contactCreated } = await findOrCreateRaceContactWithOutcome({
    db, locationId, email, name, phone: b.phone, restrictToOrg: true,
    insertFields: { source: 'corp_promo', first_name: b.first_name, last_name: b.last_name },
  })
  if (!contactId) return NextResponse.json({ success: false, code: 'capture_failed', error: 'Could not capture your details. Please try again.' }, { status: 500 })

  const nowIso = new Date().toISOString()
  // CLAIMNAME.1 — each blank name on its own: a matched contact holding a first
  // name and no surname gets the surname (the Glofox register needs both).
  await bestEffort('first/last stamp', () => fillMissingContactNames(db, contactId, { first_name: b.first_name, last_name: b.last_name }))
  await bestEffort('lead_source stamp', () => db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null))
  await bestEffort('last_lead_source stamp', () => db.from('contacts').update({ last_lead_source: leadSource, last_lead_source_at: nowIso }).eq('id', contactId))
  const a = b.attribution || {}
  // UTMSOURCE.1 — first-touch utm_source / utm_medium (mig 837). Before the
  // utm stamp below, which sets attributed_at for this same visit. Never throws.
  await stampFirstTouchSource(db, contactId, a, { module: 'corp-promo' })
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
  // MOBILEFUNNEL.1 — ticked: opt in; unticked: opt a contact made just now out
  // (a new contact's marketing defaults to on), leave an existing one alone.
  await bestEffort('consent', async () => {
    const r = await applyOfferFormConsent(db, { contactId, created: contactCreated, consent: b.consent, source: 'corp_promo', ipAddress: ip, locationId })
    if (r.result && r.result.ok === false) logError('corp-promo', 'consent write failed', { contactId, locationId, applied: r.applied })
  })
  // A Glofox promo is placed on its board by the fulfilment, after the grant.
  if (!isGlofox) await bestEffort('deal placement', () => placeWaitlistEntry(db, { contactId, locationId, title: b.first_name || 'Corporate promo' }))
  await bestEffort('meta lead', async () => {
    const { sendWebsiteConversion, fbcFromFbclid } = await import('@/lib/meta-capi')
    return sendWebsiteConversion(db, {
      locationId, email, phone: b.phone, eventName: 'Lead', eventId: b.lead_event_id || `corplead-${contactId}`,
      contentName: promo.key, fbc: fbcFromFbclid(a.fbclid) || undefined, fbp: a.fbp, clientIp: ip,
      userAgent: request.headers.get('user-agent') || undefined,
      firstName: b.first_name, lastName: b.last_name, externalId: contactId,
    })
  })

  // ── Who may claim, before anything reaches Glofox / un1t.online ──
  if (isGlofox) {
    // OPENWEEK.1 — the studio's open week promos: a granted one is the person's
    // free trial, so every other promo there refuses it.
    const listed = await listCorpPromos(db, { locationId })
    if (!listed.ok) return unavailable()
    const openWeekKeys = listed.promos.filter((p) => p && p.kind === 'open_week').map((p) => p.key)
    const gelig = await glofoxCorpPromoEligibility(db, {
      locationId, organizationId: location.organization_id ?? null, contactId, email, phone: b.phone, promoKey: promo.key, openWeekKeys,
    })
    if (!gelig.ok) return unavailable()
    if (!gelig.eligible) {
      if (gelig.reason === 'active_member') return refused('active_member', say(copy.active_member_text))
      if (gelig.reason === 'already_claimed') return refused('already_claimed', say(copy.already_claimed_text))
      if (gelig.reason === 'free_trial_used') return refused('free_trial_used', say(copy.trial_used_text))
      if (gelig.reason !== 'help_pending' && gelig.reason !== 'in_progress') {
        logWarn('corp-promo', 'glofox eligibility answered an unmapped reason', { locationId, contactId, reason: String(gelig.reason) })
      }
      // help_pending (a card is open or was handled) and in_progress: never
      // say the classes are on the account.
      return refused('help_filed', say(copy.help_text))
    }
  }
  const refusalText = {
    already_claimed: copy.already_claimed_text, free_trial_used: copy.trial_used_text, trained: copy.trained_text,
    // OPENWEEK.1 — the person-wide membership check and a balance already on the account.
    active_member: copy.active_member_text, ...(copy.holds_credits_text ? { holds_credits: copy.holds_credits_text } : {}),
  }
  if (!isGlofox) {
    const membership = await hatchActiveMembership(db, { locationId, contactId })
    if (!membership.ok) return unavailable()
    if (membership.active) return refused('active_member', say(copy.active_member_text))
    const elig = await corpPromoEligibility(db, {
      locationId, organizationId: location.organization_id ?? null, contactId, email, phone: b.phone,
      trialProductId: un1t.trialProductId, promoKey: promo.key, openWeek,
    })
    if (!elig.ok) return unavailable()
    if (!elig.eligible) return refused(elig.reason, say(refusalText[elig.reason] || copy.trained_text))
  }

  const { data: contact, error: cErr } = await db.from('contacts')
    .select(isGlofox ? 'id, email, name, first_name, last_name, phone, glofox_member_id' : 'id, email, name, first_name, last_name, phone, un1t_user_id').eq('id', contactId).maybeSingle()
  if (cErr || !contact) {
    logError('corp-promo', 'contact unreadable', { contactId, locationId, code: cErr?.code ?? null })
    return unavailable()
  }

  let version = null
  if (!isGlofox) {
    try { version = (await readUn1tLegalDocs(db, locationId)).version } catch (e) { logWarn('corp-promo', 'legal documents version unread', { locationId, errClass: e?.name }) }
  }
  const { data: claim, error: insErr } = await db.from('corp_promo_claims').insert({
    ...(pageId ? { page_id: pageId } : {}),
    location_id: locationId,
    contact_id: contactId,
    promo_key: promo.key,
    platform: promo.platform,
    first_name: b.first_name,
    last_name: b.last_name,
    customer_email: email,
    customer_phone: b.phone,
    status: 'processing',
    ...(isGlofox ? {} : { terms_accepted_at: nowIso, terms_source: 'website', terms_version: version }),
    attribution: { ...utm, ...(a.utm_source ? { utm_source: String(a.utm_source) } : {}), ...(a.utm_medium ? { utm_medium: String(a.utm_medium) } : {}) },
    lead_event_id: b.lead_event_id || null,
    ...classColumnsFor(choice.chosen),
  }).select('*').single()
  if (isGlofox && insErr?.code === '23505') {
    // Another claim for this person is already in flight (the partial unique index).
    return refused('help_filed', say(copy.help_text))
  }
  if (insErr || !claim) {
    // Ids and the code only: a PostgREST error's details can name the row.
    logError('corp-promo', 'claim insert failed', { contactId, code: insErr?.code ?? null })
    return unavailable()
  }
  if (openWeek) {
    // The picks must be on record before anything is granted: the fulfilment
    // books exactly these, and staff read them on a card.
    const { error: clsErr } = await insertClaimClasses(db, { claimId: claim.id, locationId, picks })
    if (clsErr) {
      logError('corp-promo', 'open week classes not recorded', { claimId: claim.id, locationId, code: clsErr.code ?? null })
      const { error: stampErr } = await db.from('corp_promo_claims').update({ status: 'failed', reason: 'classes_unrecorded' }).eq('id', claim.id).eq('location_id', locationId)
      if (stampErr) logError('corp-promo', 'claim not stamped failed', { claimId: claim.id, code: stampErr.code ?? null })
      return unavailable()
    }
  }

  const outcome = isGlofox
    ? await fulfilGlofoxCorpPromoClaim(db, { claim, location, contact, promo, copy, zone: zoneOfLocation(location), picks })
    : await fulfilCorpPromoClaim(db, {
      claim, location, contact, promo, copy, zone: zoneOfLocation(location), trialProductId: un1t.trialProductId, picks,
    })
  if (outcome.kind === 'unavailable') return unavailable()
  if (outcome.kind === 'help_filed') return refused('help_filed', say(copy.help_text))
  if (outcome.kind === 'ineligible') return refused(outcome.reason, say(refusalText[outcome.reason] || copy.trained_text))
  const done = corpPromoTokens({ firstName: b.first_name, credits: outcome.credits, expiresAt: outcome.expiresAt, zone: zoneOfLocation(location), studioName: location.name })
  return NextResponse.json({ success: true, data: {
    ...(openWeek ? { classes: picks.map((p) => ({ event_id: p.event_id, name: p.name, starts_at: p.starts_at })) } : {}),
    credits: outcome.credits,
    expires_at: outcome.expiresAt,
    title: fillCorpPromoTokens(copy.done_title, done),
    message: fillCorpPromoTokens(copy.done_body, done),
  } })
}
