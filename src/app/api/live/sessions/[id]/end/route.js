// POST /api/live/sessions/[id]/end
//
// End a single heart_rate_sessions row (coach kicks one member out,
// or the bridge auto-detects a strap going silent). Finalises the
// summary stats from the session's hr_samples.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { endSession } from '@/lib/live-class'
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
  if (!user.isMaster && !ALLOWED_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Coach only' }, { status: 403 })
  }

  // Look up the session's location to enforce scope before we end it.
  const db = createServerClient()
  const { data: session } = await db
    .from('heart_rate_sessions')
    .select('id, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 })
  }
  if (!user.isMaster && !getUserLocationIds(user).includes(session.location_id)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }

  const out = await endSession(db, params.id)
  if (!out.ok) {
    return NextResponse.json({ ok: false, error: out.error }, { status: 400 })
  }
  logInfo('live-class', 'session ended', {
    sessionId: params.id, locationId: session.location_id, actor: user.id,
  })
  return NextResponse.json({ ok: true, summary: out.summary, alreadyEnded: out.alreadyEnded || false })
}
