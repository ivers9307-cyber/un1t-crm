// POST /api/live/[locationId]/end-all
//
// Closes every open heart_rate_sessions at this location. One-click
// "class is over" for the coach. Each session is finalised
// individually (zones / points / avg / peak computed from samples).
//
// Auth: any coach role at the location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { endAllAtLocation } from '@/lib/live-class'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['owner', 'manager', 'head_coach', 'coach']

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  const locationId = params.locationId
  if (!user.isMaster && !ALLOWED_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Coach only' }, { status: 403 })
  }
  if (!user.isMaster && !(user.locationIds || []).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }

  const db = createServerClient()
  const out = await endAllAtLocation(db, locationId)
  logInfo('live-class', 'end-all', {
    locationId, ended: out.ended, actor: user.id,
  })
  return NextResponse.json({ ok: true, ended: out.ended })
}
