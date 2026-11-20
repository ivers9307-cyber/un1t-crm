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
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; races somewhere, the registration's
// studio (404), races there, the kind and the penalty's parent run here in
// their old order.
export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
  }

  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .select(`id, race_events ( id, location_id, kind )`)
    .eq('id', params.id)
    .single()
  if (regErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, reg.race_events?.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the registration's event location, not the caller's active studio.
  if (!hasPermissionForLocation(user, reg.race_events?.location_id, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
  }
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
    logError('races', 'penalty delete failed', { penaltyId: params.penaltyId, code: delErr.code ?? null, message: delErr.message })
    return NextResponse.json({ success: false, error: 'Could not remove the penalty just now.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
})
