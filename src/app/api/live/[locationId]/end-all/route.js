// POST /api/live/[locationId]/end-all
//
// Closes every open heart_rate_sessions at this location. One-click
// "class is over" for the coach. Each session is finalised
// individually (zones / points / avg / peak computed from samples).
//
// Auth (SEC-LIVE-API.1): a coach role at the location who ALSO holds
// `studio_management` there — the permission the /live page requires. Strictly
// narrower than before: nobody gains anything, and a role that can't open the
// board can no longer end its sessions out of band.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveLocation, LIVE_MUTATION_ROLES } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { endAllAtLocation } from '@/lib/live-class'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  const locationId = params.locationId
  const denied = guardLiveLocation(user, locationId, { roles: LIVE_MUTATION_ROLES })
  if (denied) return denied

  const db = createServerClient()
  const out = await endAllAtLocation(db, locationId)
  logInfo('live-class', 'end-all', {
    locationId, ended: out.ended, actor: user.id,
  })
  return NextResponse.json({ ok: true, ended: out.ended })
}
