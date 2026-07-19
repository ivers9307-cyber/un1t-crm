// GET /api/public/classes — live Glofox class list for the Stillorgan /start
// wizard. Public (display-safe data only); rate-limited. Stillorgan-scoped via
// the 'stillorgan' landing public_path so no arbitrary location can be queried.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { listPublicClasses } from '@/lib/public-classes'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  // SAAS-6: tenant-keyed. This route is hard-scoped to the 'stillorgan'
  // public_path (see header), so the tenant identifier is that constant
  // — already the right shape for when the route grows a location param.
  const limit = await checkRateLimit(db, `pubclasses:stillorgan:${ip}`, { max: 30, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a moment.')

  try {
    const { data: page } = await db.from('landing_page_settings')
      .select('location_id').eq('public_path', 'stillorgan').maybeSingle()
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [] } })
    const classes = await listPublicClasses(db, page.location_id, 7)
    return NextResponse.json({ success: true, data: { classes } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    return NextResponse.json({ success: true, data: { classes: [] } })
  }
}
