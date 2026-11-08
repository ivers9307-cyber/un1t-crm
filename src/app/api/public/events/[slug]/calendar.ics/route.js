// GET /api/public/events/[slug]/calendar.ics — CALENDAR.1
//
// One session of a published event as an .ics download (RFC 5545, UTC
// times from the studio's zone, the tenant's identity in UID and
// description). `?wave=<id>` names the session; it may be omitted only when
// the event has exactly one. Draft / unpublished / unknown → 404; a foreign
// or missing wave → 404. Public by design (rate-limited like the event
// payload); it reveals nothing the public event page does not.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { eventIsPublic } from '@/lib/host-events'
import { zoneOfLocation } from '@/lib/location-time'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { getLocationBranding } from '@/lib/location-branding'
import { buildEventCalendarIcs } from '@/lib/event-calendar-links'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export async function GET(request, props) {
  const params = await props.params
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `event-ics:${ip}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const { data: race, error } = await db
    .from('race_events')
    .select(`
      id, name, slug, kind, race_date, venue_name, venue_address, active, status, host_id, duration_minutes, location_id,
      locations:location_id ( id, name, address, timezone, is_host_anchor, organization_id ),
      waves:race_waves ( id, start_time, label )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .eq('status', 'published')
    .maybeSingle()
  if (error) {
    logWarn('event-ics', 'event read failed', { err: error, slug: params.slug })
    return NextResponse.json({ success: false, error: 'Unavailable' }, { status: 503 })
  }
  if (!race || !eventIsPublic(race)) return notFound()

  const waveId = new URL(request.url).searchParams.get('wave')
  const waves = Array.isArray(race.waves) ? race.waves : []
  let wave = null
  if (waveId) {
    wave = waves.find((w) => w.id === waveId) || null
    if (!wave) return notFound()
  } else if (waves.length !== 1) {
    return notFound()
  }

  let hostname = 'repset.ie'
  let brandName = ''
  try {
    hostname = new URL(await resolveCustomerBaseUrl(db, race.location_id || null)).hostname
  } catch (err) {
    logWarn('event-ics', 'tenant host unresolved; platform host in the UID', { err, slug: params.slug })
  }
  try {
    brandName = String((await getLocationBranding(db, race.location_id))?.companyName || '').trim()
  } catch (err) {
    logWarn('event-ics', 'brand unresolved; no description', { err, slug: params.slug })
  }

  const ics = buildEventCalendarIcs({ event: race, wave, zone: zoneOfLocation(race.locations), hostname, brandName })
  if (!ics) return notFound()
  const safe = String(race.slug || 'event').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'event'
  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}.ics"`,
      'Cache-Control': 'no-store',
    },
  })
}
