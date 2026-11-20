// src/app/api/live/[locationId]/detections/route.js
//
// GET /api/live/[locationId]/detections
//
// HR-DETECT.1 — the coach "Detected" tab data: every strap recorded at this
// location (linked or not), most-recently-seen first, enriched with link status
// (contact_devices) + a live-now flag (open heart_rate_session). Separate from
// the 2s /api/live poll so the hot live board stays lean; this polls slower.
//
// Auth (SEC-LIVE-API.1): member of the location + `studio_management` there,
// mirroring GET /api/live/[locationId] and the /live page.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { guardLiveLocation } from '@/lib/live-access'
import { resolveDetectionLinks } from '@/lib/hr-detections'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ROWS = 500

// withAuth only signs the caller in. The studio and the permission are judged
// AT the URL's studio by guardLiveLocation, as before (its 403s and master
// bypass unchanged).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const locationId = params?.locationId
  const denied = guardLiveLocation(user, locationId)
  if (denied) return denied

  const { data: rows, error } = await db
    .from('hr_detections')
    .select('id, device_key, protocol, first_seen_at, last_seen_at, visit_count, last_bpm, last_name, last_rssi, last_bridge_id')
    .eq('location_id', locationId)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) {
    logError('hr-detections', 'detections read failed', { err: error, locationId })
    return NextResponse.json({ ok: false, error: 'Could not load the detections.' }, { status: 500 })
  }

  const detections = await resolveDetectionLinks(db, { locationId, detections: rows || [] })
  return NextResponse.json({ ok: true, detections, capped: (rows || []).length >= MAX_ROWS })
})
