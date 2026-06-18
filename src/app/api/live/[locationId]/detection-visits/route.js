// src/app/api/live/[locationId]/detection-visits/route.js
//
// GET /api/live/[locationId]/detection-visits?detection_id=<id>
//
// HR-DETECT.1 — lazy drill-down: the appearance history for one detected strap.
// Scoped by location_id (app guard) AND detection_id. Auth mirrors the live route.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  const locationId = params.locationId
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }
  const detectionId = new URL(request.url).searchParams.get('detection_id')
  if (!detectionId) return NextResponse.json({ ok: false, error: 'detection_id required' }, { status: 400 })

  const db = createServerClient()
  const { data, error } = await db
    .from('hr_detection_visits')
    .select('id, started_at, last_sample_at, peak_bpm, last_bpm, sample_count, glofox_event_id, class_name')
    .eq('location_id', locationId)
    .eq('detection_id', detectionId)
    .order('started_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, visits: data || [] })
}
