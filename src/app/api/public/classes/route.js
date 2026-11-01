// GET /api/public/classes?path=<public_path> — live Glofox class list for a
// location's landing page (the ClassFunnel block / /start wizard). Public
// (display-safe data only); rate-limited. Location is resolved ONLY from an
// existing live studio page's slug (the `path` param, defaults to 'stillorgan'),
// so no arbitrary location can be queried. Unknown/absent path → empty list.
//
// FIFTYPLUS.1 — `&campaign=<key>` lists through the row's campaign_funnel
// block for that key instead: its allow-list over 14 days (the Glofox read's
// ceiling), and `data.campaign.configured` says whether the block has its
// trial pair, so the page can say booking is not open before anyone types.
// An unknown key answers nothing, never the whole timetable.
//
// PAGES.1 — `?page=<slug>&studio=<public path>` (studio optional on a
// one-studio page): the live page's offer block merged with its studio row
// decides the list (resolvePublicPageRequest), and `path`/`campaign` are
// ignored. A campaign_funnel page lists its allow-list and reports
// `campaign.configured` by offerConfigured; a class_funnel page lists the
// studio's timetable. Without `page`, `path` names a studio page by its slug
// and the list reads through that page (/stillorgan's own class funnel).
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { listPublicClasses, readPublicClasses } from '@/lib/public-classes'
import { resolveCampaignKey, campaignFunnelBlock, campaignFunnelConfig } from '@/lib/campaign-funnel'
import { resolveLandingPath } from '@/lib/public-landing'
import { logWarn } from '@/lib/log'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { resolvePublicPageRequest } from '@/lib/landing-pages'
import { offerConfigured } from '@/lib/landing-page-offers'

// UN1TWRITE.18 — does this studio's funnel need the terms and waiver tick
// (un1t.online with the funnel on), and in the operator's words. An
// unreadable settings row is "not required": the processor still refuses to
// create an account for a request with no recorded acceptance.
// The wording is the studio's own terms copy, the resolver's `terms` (the
// studio page's chrome.un1t_terms), as the page itself renders it.
async function termsFor(db, page) {
  let s
  try {
    s = await readUn1tWriteSettings(db, page.location_id)
  } catch (err) {
    logWarn('public-classes', 'un1t.online settings unreadable; terms tick not shown', { err })
    return { required: false }
  }
  if (s.membershipSource !== 'un1t_online' || !s.settings.funnelEnabled) return { required: false }
  return un1tTermsPayload({ terms: page.terms, studioName: s.studioName, publicPath: page.public_path })
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CAMPAIGN_DAYS = 14

// The campaign list: the block's allow-list over the full window. A timetable
// the studio could not READ (a Glofox or settings blip) is flagged, so the
// card says "try again in a minute" rather than "no classes": a paid click
// told there is nothing to book leaves.
async function listCampaignClasses(db, page, path, key) {
  const block = campaignFunnelBlock(page.blocks, key)
  if (!block) return { classes: [], campaign: { configured: false, timetable_unavailable: false } }
  const cfg = campaignFunnelConfig(block, { landingPath: path })
  const { classes, error } = await readPublicClasses(db, page.location_id, CAMPAIGN_DAYS, { allowKeywords: cfg.allowKeywords, blocks: page.blocks })
  return { classes, campaign: { configured: cfg.configured, timetable_unavailable: Boolean(error) } }
}

// PAGES.1 — the page form. Rate-limited after the page is resolved, keyed on
// the RESOLVED studio public path (the same bucket the legacy path uses for
// that studio); a request that resolves to nothing shares one 'unresolved'
// bucket per IP, so probing slugs is limited too.
const NOT_OPEN = { configured: false, timetable_unavailable: false }
const PageQuery = z.object({
  page: z.string().trim().max(40).optional(),
  studio: z.string().trim().max(40).optional(),
})
async function pageGET(db, request, ip, params) {
  const q = PageQuery.safeParse({ page: params.get('page') ?? undefined, studio: params.get('studio') ?? undefined })
  if (!q.success) return NextResponse.json({ success: false, error: 'Invalid request' }, { status: 400 })
  const r = await resolvePublicPageRequest(db, {
    hostname: request.headers.get('host'), page: q.data.page, studio: q.data.studio,
  })
  const limit = await checkRateLimit(db, `pubclasses:${r.ok ? r.publicPath : 'unresolved'}:${ip}`, { max: 30, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a moment.')
  if (!r.ok) {
    if (r.reason === 'studio_required') return NextResponse.json({ success: false, error: 'studio_required' }, { status: 400 })
    // A read that failed is the timetable blip, never "no classes".
    const campaign = r.reason === 'unreadable' ? { configured: true, timetable_unavailable: true } : NOT_OPEN
    return NextResponse.json({ success: true, data: { classes: [], campaign } })
  }
  const studio = { location_id: r.locationId, public_path: r.publicPath, terms: r.terms }
  try {
    const offerType = r.page.offer_type
    if (offerType === 'one_class') {
      const block = r.blocks.find((b) => b && typeof b === 'object' && b.type === 'campaign_funnel') || null
      if (!block) return NextResponse.json({ success: true, data: { classes: [], campaign: NOT_OPEN } })
      const cfg = campaignFunnelConfig(block, { landingPath: r.publicPath })
      const configured = offerConfigured('campaign_funnel', block, { landingPath: r.publicPath })
      const [read, terms] = await Promise.all([
        readPublicClasses(db, r.locationId, CAMPAIGN_DAYS, { allowKeywords: cfg.allowKeywords, blocks: r.blocks }),
        termsFor(db, studio),
      ])
      return NextResponse.json({ success: true, data: { classes: read.classes, terms, campaign: { configured, timetable_unavailable: Boolean(read.error) } } })
    }
    if (offerType === 'class_funnel') {
      const [classes, terms] = await Promise.all([listPublicClasses(db, r.locationId, 7, { blocks: r.blocks }), termsFor(db, studio)])
      return NextResponse.json({ success: true, data: { classes, terms } })
    }
    // CLASSFIRST.1 — a paid trial or a promo page asks for the class before
    // the details: the studio's visible timetable (hidden keywords out, full
    // classes left out; a un1t.online studio lists its synced un1t_events)
    // over the same 14 days, in the shape the pick step reads. The deny-list
    // alone governs here (no allow-list), as on /start.
    if (offerType === 'paid_trial' || offerType === 'promo_credits') {
      const [read, terms] = await Promise.all([
        readPublicClasses(db, r.locationId, CAMPAIGN_DAYS, { blocks: r.blocks }),
        termsFor(db, studio),
      ])
      return NextResponse.json({ success: true, data: { classes: read.classes, terms, campaign: { configured: true, timetable_unavailable: Boolean(read.error) } } })
    }
    // A page whose offer is not a class: nothing to list here.
    return NextResponse.json({ success: true, data: { classes: [], campaign: NOT_OPEN } })
  } catch (e) {
    logWarn('public-classes', 'page list failed', { err: e, pageId: r.pageId })
    return NextResponse.json({ success: true, data: { classes: [], campaign: { configured: true, timetable_unavailable: true } } })
  }
}

export async function GET(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  const pageParams = new URL(request.url).searchParams
  if (pageParams.get('page')?.trim()) return pageGET(db, request, ip, pageParams)
  // SAAS-6: tenant-keyed by the RESOLVED landing path (defaults to 'stillorgan'
  // when absent) so one location's polling can't exhaust another's window for
  // the same IP. resolveLandingPath never throws, so it's safe above the try.
  const params = new URL(request.url).searchParams
  const path = resolveLandingPath(params.get('path'))
  const campaignKey = resolveCampaignKey(params.get('campaign'))
  const limit = await checkRateLimit(db, `pubclasses:${path}:${ip}`, { max: 30, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a moment.')

  try {
    // The studio page the path names. A miss or a failed read is "no page",
    // as it always was.
    const legacy = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), legacyPath: path })
    const page = legacy.ok ? { location_id: legacy.locationId, public_path: legacy.publicPath, blocks: legacy.blocks, terms: legacy.terms } : null
    // A campaign page with no row to read is "not open", not "no classes".
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [], ...(campaignKey ? { campaign: { configured: false, timetable_unavailable: false } } : {}) } })
    if (campaignKey) {
      const [listed, terms] = await Promise.all([listCampaignClasses(db, page, path, campaignKey), termsFor(db, page)])
      return NextResponse.json({ success: true, data: { classes: listed.classes, terms, campaign: listed.campaign } })
    }
    const [classes, terms] = await Promise.all([listPublicClasses(db, page.location_id, 7, { blocks: page.blocks }), termsFor(db, page)])
    return NextResponse.json({ success: true, data: { classes, terms } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    // A list that threw: the page cannot tell, so say the timetable could not be read.
    return NextResponse.json({ success: true, data: { classes: [], ...(campaignKey ? { campaign: { configured: true, timetable_unavailable: true } } : {}) } })
  }
}
