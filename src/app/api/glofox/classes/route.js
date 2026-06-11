// GET /api/glofox/classes?location_id=<uuid>&days=7
//
// UIX-P3b — upcoming Glofox classes for the unified inbox's Book tab.
// Backed by the probe-verified GET /2.0/events?start&end (see
// fetchUpcomingEvents in src/lib/glofox.js). Returns a slim,
// operator-facing shape; inactive + private events are filtered out.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import {
  fetchUpcomingEvents,
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
} from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// time_start arrived as an opaque value in the probe sample (truncated
// before the field) — the events query takes unix seconds, so that is
// the likely shape; parse defensively either way.
function toMillis(timeStart) {
  if (typeof timeStart === 'number') {
    // Heuristic: unix seconds < 10^12 < unix millis.
    return timeStart < 1e12 ? timeStart * 1000 : timeStart
  }
  const t = new Date(timeStart).getTime()
  return Number.isFinite(t) ? t : null
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 14)

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({ success: true, configured: false, classes: [] })
  }

  const now = Math.floor(Date.now() / 1000)
  const result = await fetchUpcomingEvents(creds, { start: now, end: now + days * 86400, limit: 100 })
  if (!result.ok) {
    return NextResponse.json({
      success: false,
      error: result.body?.message || `Glofox events fetch failed (HTTP ${result.status})`,
    }, { status: 502 })
  }

  const classes = result.events
    .filter(e => e.active !== false && e.private !== true)
    .map(e => {
      const size = Number(e.size) || 0
      const booked = Number(e.booked) || 0
      return {
        id: e._id,
        name: e.name,
        time_start_ms: toMillis(e.time_start),
        duration: e.duration ?? null,
        size,
        booked,
        spots_left: size > 0 ? Math.max(0, size - booked) : null,
        waiting: Number(e.waiting) || 0,
        // E2E screenshot showed trainers arrive as raw 24-hex member
        // ids — display-worthless, so drop hex ids and keep only
        // human-readable names (object shapes or real name strings).
        trainers: Array.isArray(e.trainers)
          ? e.trainers
              .map(t => (typeof t === 'string' ? t : t?.name || t?.first_name || null))
              .filter(t => t && !/^[0-9a-f]{24}$/i.test(t))
          : [],
        booking_status: e.booking_status ?? null,
      }
    })
    .filter(c => c.time_start_ms == null || c.time_start_ms > Date.now() - 60_000)
    .sort((a, b) => (a.time_start_ms || 0) - (b.time_start_ms || 0))

  return NextResponse.json({ success: true, configured: true, classes })
}
