// POST /api/registrations/[id]/race-finish
//
// Stamps race_finished_at = NOW() if started but not finished.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`
      id, race_started_at, race_finished_at,
      race_events ( id, location_id )
    `)
    .eq('id', params.id)
    .single()
  if (lookupErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, reg.race_events?.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  if (!reg.race_started_at) {
    return NextResponse.json({
      success: false,
      error: 'Cannot finish a race that has not started.',
      code: 'not_started',
    }, { status: 409 })
  }
  if (reg.race_finished_at) {
    return NextResponse.json({
      success: true,
      no_op: true,
      race_finished_at: reg.race_finished_at,
    })
  }

  const finishedAt = new Date().toISOString()
  const { error: upErr } = await db
    .from('race_registrations')
    .update({ race_finished_at: finishedAt })
    .eq('id', reg.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    race_started_at: reg.race_started_at,
    race_finished_at: finishedAt,
  })
}
