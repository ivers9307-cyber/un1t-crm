// POST /api/public/events/[slug]/view — HOSTSTATS.1
//
// The signup page's page-view beacon. The widget posts its per-tab session
// id and first-touch attribution on mount; one row per (event, session, day
// on the studio's clock) is kept, a repeat hits the unique key and is not
// counted. A draft / unpublished / unknown event is 404 (the same answer as
// the event payload, so the beacon reveals nothing new). Telemetry never
// 5xxs the visitor: a failed insert is logged and answered `recorded:false`.
// Rate-limited per slug + IP like the event payload. No auth — public page.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { eventIsPublic } from '@/lib/host-events'
import { zoneOfLocation, todayStrIn } from '@/lib/location-time'
import { resolveEventAttribution } from '@/lib/event-attribution-server'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const ViewBodySchema = z.object({
  session_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  attribution: z.record(z.string(), z.unknown()).nullable().optional(),
})

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `event-view:${params.slug}:${ip}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const validation = await validateBody(request, ViewBodySchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data: race, error } = await db
    .from('race_events')
    .select('id, active, status, host_id, location_id, locations:location_id ( timezone )')
    .eq('slug', params.slug)
    .eq('active', true)
    .eq('status', 'published')
    .maybeSingle()
  if (error) {
    logWarn('event-view', 'event read failed', { err: error, slug: params.slug })
    return NextResponse.json({ success: true, data: { recorded: false } })
  }
  if (!race || !eventIsPublic(race)) return notFound()

  const a = await resolveEventAttribution(db, body.attribution, race, { requestHost: new URL(request.url).host })
  const { error: insErr } = await db.from('event_page_views').insert({
    race_event_id: race.id,
    session_id: body.session_id,
    source: a?.source ?? 'direct',
    utm_campaign: a?.utm_campaign ?? null,
    utm_content: a?.utm_content ?? null,
    referrer_host: a?.referrer_host ?? null,
    day: todayStrIn(zoneOfLocation(race.locations)),
  })
  if (insErr) {
    // 23505 = the same session already counted today: by design, not news.
    if (insErr.code !== '23505') logWarn('event-view', 'page view not recorded', { err: insErr, slug: params.slug })
    return NextResponse.json({ success: true, data: { recorded: false } })
  }
  return NextResponse.json({ success: true, data: { recorded: true } })
}
