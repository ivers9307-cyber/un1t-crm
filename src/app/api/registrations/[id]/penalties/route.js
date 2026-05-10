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
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

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

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const validation = await validateBody(request, PenaltySchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`id, race_events ( id, location_id, kind )`)
    .eq('id', params.id)
    .single()
  if (lookupErr || !reg) {
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
    return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: inserted }, { status: 201 })
}
