// DELETE /api/registrations/[id]/penalties/[penaltyId]
//
// Operator undo for a previously-applied penalty. Hard delete —
// the penalty was a manual entry, removing it should leave no
// residue (the audit trail is the row's existence, not its
// soft-deletion state).
//
// Validates penalty.race_registration_id matches the [id] param
// so a forged URL can't delete penalties cross-registration. The
// RLS policy on race_penalties also enforces location-membership,
// but checking here gives a cleaner 404 instead of a silent
// service-role no-op.
//
// Race-only (kind='race' gate) — same as POST.
// Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .select(`id, race_events ( id, location_id, kind )`)
    .eq('id', params.id)
    .single()
  if (regErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, reg.race_events?.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  if (reg.race_events?.kind && reg.race_events.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `Penalties don't apply to ${reg.race_events.kind} events.`,
    }, { status: 409 })
  }

  // Confirm the penalty actually belongs to THIS registration.
  // Returning 404 (not 403) for a mismatched id matches the
  // pattern of "the resource doesn't exist at this URL" — it
  // does exist somewhere else, but not under this parent.
  const { data: pen, error: penErr } = await db
    .from('race_penalties')
    .select('id, race_registration_id')
    .eq('id', params.penaltyId)
    .single()
  if (penErr || !pen) {
    return NextResponse.json({ success: false, error: 'Penalty not found' }, { status: 404 })
  }
  if (pen.race_registration_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Penalty not found' }, { status: 404 })
  }

  const { error: delErr } = await db
    .from('race_penalties')
    .delete()
    .eq('id', params.penaltyId)
  if (delErr) {
    return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
