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
      .select('location_id').eq('public_path', path).maybeSingle()
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [] } })
    const classes = await listPublicClasses(db, page.location_id, 7)
    return NextResponse.json({ success: true, data: { classes } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    return NextResponse.json({ success: true, data: { classes: [] } })
  }
}
