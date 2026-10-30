// GET /api/public/classes?path=<public_path> — live Glofox class list for a
// location's landing page (the ClassFunnel block / /start wizard). Public
// (display-safe data only); rate-limited. Location is resolved ONLY from an
// existing landing_page_settings.public_path (defaults to 'stillorgan'), so no
// arbitrary location can be queried. Unknown/absent path → empty list.
//
// FIFTYPLUS.1 — `&campaign=<key>` lists through the row's campaign_funnel
// block for that key instead: its allow-list over 14 days (the Glofox read's
// ceiling), and `data.campaign.configured` says whether the block has its
// trial pair, so the page can say booking is not open before anyone types.
// An unknown key answers nothing, never the whole timetable.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { listPublicClasses, readPublicClasses } from '@/lib/public-classes'
import { resolveCampaignKey, campaignFunnelBlock, campaignFunnelConfig } from '@/lib/campaign-funnel'
import { resolveLandingPath } from '@/lib/public-landing'
import { logWarn } from '@/lib/log'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'

// UN1TWRITE.18 — does this studio's funnel need the terms and waiver tick
// (un1t.online with the funnel on), and in the operator's words. An
// unreadable settings row is "not required": the processor still refuses to
// create an account for a request with no recorded acceptance.
async function termsFor(db, page) {
  let s
  try {
    s = await readUn1tWriteSettings(db, page.location_id)
  } catch (err) {
    logWarn('public-classes', 'un1t.online settings unreadable; terms tick not shown', { err })
    return { required: false }
  }
  if (s.membershipSource !== 'un1t_online' || !s.settings.funnelEnabled) return { required: false }
  return un1tTermsPayload({ blocks: page.blocks, studioName: s.studioName, publicPath: page.public_path })
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CAMPAIGN_DAYS = 14

// The campaign list: the block's allow-list over the full window, with the
// old contract ([] on any failure) the public list has always had.
async function listCampaignClasses(db, page, path, key) {
  const block = campaignFunnelBlock(page.blocks, key)
  if (!block) return { classes: [], campaign: { configured: false } }
  const cfg = campaignFunnelConfig(block, { landingPath: path })
  const { classes } = await readPublicClasses(db, page.location_id, CAMPAIGN_DAYS, { allowKeywords: cfg.allowKeywords })
  return { classes, campaign: { configured: cfg.configured } }
}

export async function GET(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  // SAAS-6: tenant-keyed by the RESOLVED landing path (defaults to 'stillorgan'
  // when absent) so one location's polling can't exhaust another's window for
  // the same IP. resolveLandingPath never throws, so it's safe above the try.
  const params = new URL(request.url).searchParams
  const path = resolveLandingPath(params.get('path'))
  const campaignKey = resolveCampaignKey(params.get('campaign'))
  const limit = await checkRateLimit(db, `pubclasses:${path}:${ip}`, { max: 30, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a moment.')

  try {
    const { data: page } = await db.from('landing_page_settings')
      .select('location_id, public_path, blocks').eq('public_path', path).maybeSingle()
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [] } })
    if (campaignKey) {
      const [listed, terms] = await Promise.all([listCampaignClasses(db, page, path, campaignKey), termsFor(db, page)])
      return NextResponse.json({ success: true, data: { classes: listed.classes, terms, campaign: listed.campaign } })
    }
    const [classes, terms] = await Promise.all([listPublicClasses(db, page.location_id, 7), termsFor(db, page)])
    return NextResponse.json({ success: true, data: { classes, terms } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    return NextResponse.json({ success: true, data: { classes: [] } })
  }
}
