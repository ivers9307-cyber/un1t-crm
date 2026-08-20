// POST /api/live/sessions/[id]/end
//
// End a single heart_rate_sessions row (coach kicks one member out,
// or the bridge auto-detects a strap going silent). Finalises the
// summary stats from the session's hr_samples.
//
// SEC-LIVE-API.1 — this route used to be an existence oracle: an unknown id
// 404'd but a REAL id at a location you can't reach 403'd, which confirmed the
// id exists. The house rule (CLAUDE.md) is 404-not-403 on detail routes, so
// every post-lookup refusal now collapses to the same 404 — missing, foreign
// and permission-less are indistinguishable. The role check keeps its 403
// because it fires BEFORE the lookup and so reveals nothing about the id.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveSession, LIVE_MUTATION_ROLES } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { endSession } from '@/lib/live-class'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Pre-lookup role check: no id has been touched yet, so a 403 here is safe.
  // Resolved against the user's active-location role — the session's location
  // isn't known until after the lookup, and the post-lookup guard re-checks
  // both membership and `studio_management` at the session's real location.
  if (!user.isMaster && !LIVE_MUTATION_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Coach only' }, { status: 403 })
  }

  // Look up the session's location to enforce scope before we end it.
  const db = createServerClient()
  const { data: session } = await db
    .from('heart_rate_sessions')
    .select('id, location_id')
    .eq('id', params.id)
    .maybeSingle()
  const denied = guardLiveSession(user, session)
  if (denied) return denied

  const out = await endSession(db, params.id)
  if (!out.ok) {
    return NextResponse.json({ ok: false, error: out.error }, { status: 400 })
  }
  logInfo('live-class', 'session ended', {
    sessionId: params.id, locationId: session.location_id, actor: user.id,
  })
  return NextResponse.json({ ok: true, summary: out.summary, alreadyEnded: out.alreadyEnded || false })
}
