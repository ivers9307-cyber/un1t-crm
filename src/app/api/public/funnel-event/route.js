// POST /api/public/funnel-event — capture one /start booking-funnel step event
// into funnel_events, so the Ads dashboard can show the drop-off point (overall
// and per-ad) from the CRM's own data. Public (no auth) + rate-limited; a
// best-effort insert that never errors the client — telemetry must never break
// the funnel. Location is resolved from the landing public_path so every row is
// segmented per studio.
//
// PAGES.1 — `page` + `studio` (studio optional on a one-studio page): the
// location is the live page's resolved studio and the row records `page_id`;
// `location_path` is ignored. A page that does not resolve is ignored (200),
// as an unknown path always was. Without `page` the legacy location_path read
// (PR1; PR3 deletes it) is unchanged.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { parseFunnelEvent } from '@/lib/funnel-events'
import { resolvePublicPageRequest } from '@/lib/landing-pages'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const PageFields = z.object({
  page: z.string().trim().max(40).optional(),
  studio: z.string().trim().max(40).optional(),
})
const ignored = () => NextResponse.json({ success: true, data: { ignored: true } })

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  const body = await request.json().catch(() => ({}))

  if (typeof body?.page === 'string' && body.page.trim()) {
    const fields = PageFields.safeParse({ page: body.page, studio: typeof body.studio === 'string' ? body.studio : undefined })
    if (!fields.success) return ignored()
    // Resolved first, then limited on the RESOLVED studio path (the legacy
    // key for that studio); nothing resolved shares an 'unresolved' bucket.
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), page: fields.data.page, studio: fields.data.studio })
    const limit = await checkRateLimit(db, `funnelevt:${r.ok ? r.publicPath : 'unresolved'}:${ip}`, { max: 60, windowMs: 10 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many events.')
    const event = parseFunnelEvent(body)
    if (!event || !r.ok) return ignored()
    return insertEvent(db, { locationId: r.locationId, pageId: r.pageId }, event)
  }

  const publicPath = typeof body.location_path === 'string' ? body.location_path.slice(0, 64) : 'stillorgan'

  // A full funnel is ~6 events; allow bursts + refreshes without abuse.
  // SAAS-6: tenant-keyed (the landing public_path, resolved to a studio
  // below) — one tenant's funnel telemetry can never consume another
  // tenant's window for the same IP. Body parse is pure so it can run
  // first to expose the path.
  const limit = await checkRateLimit(db, `funnelevt:${publicPath}:${ip}`, { max: 60, windowMs: 10 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many events.')

  const event = parseFunnelEvent(body)
  // Unknown/invalid step → silently ignore (200) rather than error the client.
  if (!event) return ignored()
  // PR1 legacy (PR3 deletes it): the studio's landing_page_settings row.
  const { data: page } = await db.from('landing_page_settings')
    .select('location_id').eq('public_path', publicPath).maybeSingle()
  if (!page?.location_id) return ignored()
  return insertEvent(db, { locationId: page.location_id, pageId: null }, event)
}

// Best-effort: a failed insert is logged (the code only) and still answers success.
async function insertEvent(db, { locationId, pageId }, event) {
  try {
    const { error } = await db.from('funnel_events').insert({
      location_id: locationId,
      ...(pageId ? { page_id: pageId } : {}),
      session_id: event.session_id,
      funnel: event.funnel,
      step: event.step,
      ad_provider: event.ad_provider,
      ad_external_id: event.ad_external_id,
      utm_campaign: event.utm_campaign,
      utm_content: event.utm_content,
      utm_term: event.utm_term,
      meta: event.meta,
    })
    if (error) logWarn('funnel-event', 'insert failed', { code: error.code ?? null })
  } catch (e) {
    logWarn('funnel-event', 'insert failed', { err: e })
  }
  return NextResponse.json({ success: true })
}
