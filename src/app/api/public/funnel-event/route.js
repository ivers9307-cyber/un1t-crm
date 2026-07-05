// POST /api/public/funnel-event — capture one /start booking-funnel step event
// into funnel_events, so the Ads dashboard can show the drop-off point (overall
// and per-ad) from the CRM's own data. Public (no auth) + rate-limited; a
// best-effort insert that never errors the client — telemetry must never break
// the funnel. Location is resolved from the landing public_path so every row is
// segmented per studio.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { parseFunnelEvent } from '@/lib/funnel-events'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  // A full funnel is ~6 events; allow bursts + refreshes without abuse.
  const limit = await checkRateLimit(db, `funnelevt:${ip}`, { max: 60, windowMs: 10 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many events.')

  const body = await request.json().catch(() => ({}))
  const event = parseFunnelEvent(body)
  // Unknown/invalid step → silently ignore (200) rather than error the client.
  if (!event) return NextResponse.json({ success: true, data: { ignored: true } })

  const publicPath = typeof body.location_path === 'string' ? body.location_path.slice(0, 64) : 'stillorgan'
  const { data: page } = await db.from('landing_page_settings')
    .select('location_id').eq('public_path', publicPath).maybeSingle()
  if (!page?.location_id) return NextResponse.json({ success: true, data: { ignored: true } })

  try {
    await db.from('funnel_events').insert({
      location_id: page.location_id,
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
  } catch (e) {
    logWarn('funnel-event', 'insert failed', { err: e })
  }
  return NextResponse.json({ success: true })
}
