// POST /api/registrations/[id]/penalties
//
// Apply a time penalty (or credit) to a race registration. One
// row per applied penalty (mig 124). The control panel sums these
// client-side for display.
//
// Race-only (kind='race' gate) — workshops / seminars / etc. don't
// have timing semantics so penalties don't apply.
//
// Body: { seconds: int, reason: string }
//   seconds: ±7200 (validated by both Zod here AND a CHECK
//            constraint on the table).
//   reason : non-empty, max 500 chars (CHECK on table).
//
// Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PenaltySchema = z.object({
  // Bounded matches the DB CHECK. Operator-friendly range (most
  // are single-digit minutes); ±2h ceiling guards against typos.
  seconds: z.number().int().min(-7200).max(7200).refine((s) => s !== 0, {
    message: 'Penalty seconds cannot be zero — pick + (penalty) or - (credit).',
  }),
  reason: z.string().trim().min(1).max(500),
}).strict()

// withAuth only signs the caller in. Every check after it runs by hand, in the
// order it always has: races anywhere 403, body 400, the registration 404, its
// studio 404, races there 403, race-only 409.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature not enabled for your account' }, { status: 403 })
  }

  const validation = await validateBody(request, PenaltySchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`id, race_events ( id, location_id, kind )`)
    .eq('id', params?.id)
    .single()
  if (lookupErr || !reg) {
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

  const { data: inserted, error: insErr } = await db
    .from('race_penalties')
    .insert({
      race_registration_id: params.id,
      seconds: body.seconds,
      reason: body.reason.trim(),
      applied_by: user.id || null,
    })
    .select('id, seconds, reason, applied_by, applied_at')
    .single()
  if (insErr) {
    logError('race-penalties', 'penalty insert failed', { registrationId: params.id, err: insErr })
    return NextResponse.json({ success: false, error: 'Could not apply the penalty.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: inserted }, { status: 201 })
})
