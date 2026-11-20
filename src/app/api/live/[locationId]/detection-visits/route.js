// src/app/api/live/[locationId]/detection-visits/route.js
//
// GET /api/live/[locationId]/detection-visits?detection_id=<id>
//
// HR-DETECT.1 — lazy drill-down: the appearance history for one detected strap.
// Scoped by location_id (app guard) AND detection_id. Auth mirrors the live
// route: member of the location + `studio_management` there (SEC-LIVE-API.1).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { guardLiveLocation } from '@/lib/live-access'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; guardLiveLocation judges membership and
// studio_management AT the URL's studio, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const locationId = params?.locationId
  const denied = guardLiveLocation(user, locationId)
  if (denied) return denied
  const detectionId = new URL(request.url).searchParams.get('detection_id')
  if (!detectionId) return NextResponse.json({ ok: false, error: 'detection_id required' }, { status: 400 })

  const { data, error } = await db
    .from('hr_detection_visits')
    .select('id, started_at, last_sample_at, peak_bpm, last_bpm, sample_count, glofox_event_id, class_name')
    .eq('location_id', locationId)
    .eq('detection_id', detectionId)
    .order('started_at', { ascending: false })
    .limit(50)
  if (error) {
    logError('live-class', 'detection visits read failed', { err: error, locationId })
    return NextResponse.json({ ok: false, error: 'Could not load the visits.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, visits: data || [] })
})
