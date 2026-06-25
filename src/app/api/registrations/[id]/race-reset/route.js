// POST /api/registrations/[id]/race-reset
//
// Operator-mistake undo. Clears both timestamps back to NULL.
// Doesn't touch the team_id link or status — just the timing.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`id, race_events ( id, location_id, kind )`)
    .eq('id', params.id)
    .single()
  if (lookupErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, reg.race_events?.location_id)
  if (guard) return guard

  // Mig 122 (E7): race-day timing only applies to kind='race'.
  if (reg.race_events?.kind && reg.race_events.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `Race-day timing doesn't apply to ${reg.race_events.kind} events.`,
    }, { status: 409 })
  }

  const { error: upErr } = await db
    .from('race_registrations')
    .update({ race_started_at: null, race_finished_at: null })
    .eq('id', reg.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
