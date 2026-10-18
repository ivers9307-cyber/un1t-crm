// GET /api/public/classes?path=<public_path> — live Glofox class list for a
// location's landing page (the ClassFunnel block / /start wizard). Public
// (display-safe data only); rate-limited. Location is resolved ONLY from an
// existing landing_page_settings.public_path (defaults to 'stillorgan'), so no
// arbitrary location can be queried. Unknown/absent path → empty list.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { listPublicClasses } from '@/lib/public-classes'
import { resolveLandingPath } from '@/lib/public-landing'
import { logWarn } from '@/lib/log'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { un1tFunnelCopyFromBlocks } from '@/lib/un1t-online-funnel-copy'
import { legalDocPathFor } from '@/lib/un1t-online-legal'

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
  const copy = un1tFunnelCopyFromBlocks(page.blocks)
  return {
    required: true,
    label: copy.terms_label.replace(/\{studio_name\}/g, s.studioName || 'the studio'),
    terms_link_label: copy.terms_link_label,
    waiver_link_label: copy.waiver_link_label,
    required_message: copy.terms_required_message,
    terms_url: legalDocPathFor(page.public_path, 'terms'),
    waiver_url: legalDocPathFor(page.public_path, 'waiver'),
  }
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  // SAAS-6: tenant-keyed by the RESOLVED landing path (defaults to 'stillorgan'
  // when absent) so one location's polling can't exhaust another's window for
  // the same IP. resolveLandingPath never throws, so it's safe above the try.
  const path = resolveLandingPath(new URL(request.url).searchParams.get('path'))
  const limit = await checkRateLimit(db, `pubclasses:${path}:${ip}`, { max: 30, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a moment.')

  try {
    const { data: page } = await db.from('landing_page_settings')
      .select('location_id, public_path, blocks').eq('public_path', path).maybeSingle()
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [] } })
    const [classes, terms] = await Promise.all([listPublicClasses(db, page.location_id, 7), termsFor(db, page)])
    return NextResponse.json({ success: true, data: { classes, terms } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    return NextResponse.json({ success: true, data: { classes: [] } })
  }
}
