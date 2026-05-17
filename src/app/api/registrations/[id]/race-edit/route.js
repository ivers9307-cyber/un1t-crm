// PATCH /api/registrations/[id]/race-edit
//
// Operator manual override for race-day timing. Fixes wrong timer
// taps after the fact: "we tapped Start late by 12 seconds" or
// "we accidentally hit Finish on the wrong team — un-finish them".
//
// Body shape (all fields optional — only the ones present are
// touched):
//   { started_at:  ISO string | null,
//     finished_at: ISO string | null }
//
// Setting finished_at to null while started_at is set is the
// "un-finish" path — the team goes back into On Course and the
// race-day UI picks it up on the next 2s polling tick. Setting
// started_at to null clears the whole timing (equivalent to
// race-reset, but accessible from the same UI surface).
//
// Race-only by design (matches E7 of events expansion) — gated on
// race_events.kind='race'. Workshops / seminars / etc. don't have
// race-day timing semantics and 409 here.
//
// Manager+ at the race's location. No audit trail at the row level
// (per Richard's "anyone with race-day control" choice — same gate
// as the existing start/finish/reset buttons).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Both fields nullable (clear) or ISO datetime strings. .strict()
// surfaces typos (e.g. {started: ...} instead of {started_at: ...})
// instead of silently no-opping.
const EditSchema = z.object({
  started_at:  z.string().datetime().nullable().optional(),
  finished_at: z.string().datetime().nullable().optional(),
}).strict().refine(
  (d) => d.started_at !== undefined || d.finished_at !== undefined,
  { message: 'At least one of started_at / finished_at is required.' },
)

export async function PATCH(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const validation = await validateBody(request, EditSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`
      id, race_started_at, race_finished_at,
      race_events ( id, location_id, kind )
    `)
    .eq('id', params.id)
    .single()
  if (lookupErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, reg.race_events?.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Mig 122 (E7): race-day timing only applies to kind='race'.
  if (reg.race_events?.kind && reg.race_events.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `Race-day timing doesn't apply to ${reg.race_events.kind} events.`,
    }, { status: 409 })
  }

  // Logical sanity: if both fields are present and finished_at is
  // earlier than started_at, refuse — the elapsed-time math would
  // go negative. (Allowed when only one side is being changed and
  // the other side is null on disk — the un-finished case.)
  const newStart  = body.started_at  !== undefined ? body.started_at  : reg.race_started_at
  const newFinish = body.finished_at !== undefined ? body.finished_at : reg.race_finished_at
  if (newStart && newFinish && new Date(newFinish).getTime() < new Date(newStart).getTime()) {
    return NextResponse.json({
      success: false,
      error: 'finished_at cannot be before started_at.',
    }, { status: 400 })
  }

  const patch = {}
  if (body.started_at  !== undefined) patch.race_started_at  = body.started_at
  if (body.finished_at !== undefined) patch.race_finished_at = body.finished_at

  const { data: updated, error: upErr } = await db
    .from('race_registrations')
    .update(patch)
    .eq('id', params.id)
    .select('id, race_started_at, race_finished_at')
    .single()
  if (upErr) {
    return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: updated })
}
