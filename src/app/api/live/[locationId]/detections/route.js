// src/app/api/live/[locationId]/detections/route.js
//
// GET /api/live/[locationId]/detections
//
// HR-DETECT.1 — the coach "Detected" tab data: every strap recorded at this
// location (linked or not), most-recently-seen first, enriched with link status
// (contact_devices) + a live-now flag (open heart_rate_session). Separate from
// the 2s /api/live poll so the hot live board stays lean; this polls slower.
//
// Auth: any staff at the location (mirrors GET /api/live/[locationId]).

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { resolveDetectionLinks } from '@/lib/hr-detections'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ROWS = 500

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  const locationId = params.locationId
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: rows, error } = await db
    .from('hr_detections')
    .select('id, device_key, protocol, first_seen_at, last_seen_at, visit_count, last_bpm, last_name, last_rssi, last_bridge_id')
    .eq('location_id', locationId)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  const detections = await resolveDetectionLinks(db, { locationId, detections: rows || [] })
  return NextResponse.json({ ok: true, detections, capped: (rows || []).length >= MAX_ROWS })
}
