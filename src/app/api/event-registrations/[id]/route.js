// /api/event-registrations/[id]
//
// PUT    — move a registration to a different wave, change status,
//          or update team_composition. Manager+ at race location.
// DELETE — remove the registration entirely (and ON DELETE CASCADE
//          from race_registrations doesn't take the team — teams
//          live across events).
//
// Note: race-day timing routes (start/finish/reset) live at
// /api/registrations/[id]/race-* — they're a separate concern.
// This route is for team management edits.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UpdateSchema = z.object({
  wave_id: z.string().uuid().optional(),
  status: z.enum(['pending_payment', 'confirmed', 'cancelled', 'no_show']).optional(),
})

async function loadReg(db, regId) {
  return db
    .from('race_registrations')
    .select(`
      id, status, wave_id, race_event_id, team_id,
      race:race_event_id ( id, location_id, waves:race_waves ( id ) )
    `)
    .eq('id', regId)
    .single()
}

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
  }

  const validation = await validateBody(request, UpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await loadReg(db, params.id)
  if (lookupErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, reg.race?.location_id)
  if (guard) return guard

  const updates = {}
  if (body.wave_id) {
    // Wave must belong to the same race.
    const validWaves = (reg.race?.waves || []).map((w) => w.id)
    if (!validWaves.includes(body.wave_id)) {
      return NextResponse.json({
        success: false,
        error: 'Wave does not belong to this race.',
      }, { status: 400 })
    }
    updates.wave_id = body.wave_id
  }
  if (body.status) updates.status = body.status
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: true, data: { unchanged: true } })
  }

  const { error } = await db
    .from('race_registrations')
    .update(updates)
    .eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true, data: { applied: updates } })
}

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await loadReg(db, params.id)
  if (lookupErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, reg.race?.location_id)
  if (guard) return guard

  const { error } = await db
    .from('race_registrations')
    .delete()
    .eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true })
}
