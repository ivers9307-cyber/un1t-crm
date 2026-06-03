// GET / PUT /api/churn-radar/dunning-settings
//
// RADAR-PAY.1 (Churn Radar Phase 2) — designate the manual email/SMS
// sequence the one-click "Send payment reminder" action enrols
// payment-slipping + locked members into. The pointer lives in
// locations.dunning_sequence_id (mig 243); NULL = the dunning action
// is disabled.
//
// GET  → { dunning_sequence_id, sequences: [{ id, name, active }] }
//        (sequences = the location's manual sequences, the only ones a
//        member can be hand-enrolled into, so the only valid picks).
// PUT  { dunning_sequence_id: uuid | null } → set or clear it.
//
// Access: churn_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function guard() {
  const user = await getCurrentUser()
  if (!user) {
    return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!hasPermission(user, 'churn_radar')) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return { error: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  }
  return { locationId }
}

export async function GET() {
  const g = await guard()
  if (g.error) return g.error
  const db = createServerClient()

  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('dunning_sequence_id')
    .eq('id', g.locationId)
    .single()
  if (locErr) {
    return NextResponse.json({ success: false, error: locErr.message }, { status: 500 })
  }

  // Only manual sequences are hand-enrollable, so they're the only
  // valid dunning targets — trigger-driven sequences enrol themselves.
  const { data: sequences, error: seqErr } = await db
    .from('email_sequences')
    .select('id, name, active')
    .eq('location_id', g.locationId)
    .eq('trigger_type', 'manual')
    .order('name', { ascending: true })
  if (seqErr) {
    return NextResponse.json({ success: false, error: seqErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: {
      dunning_sequence_id: loc?.dunning_sequence_id || null,
      sequences: sequences || [],
    },
  })
}

export async function PUT(request) {
  const g = await guard()
  if (g.error) return g.error

  let body
  try { body = await request.json() } catch { body = {} }
  const raw = body?.dunning_sequence_id
  const seqId = raw === null || raw === '' || raw === undefined ? null : String(raw)

  const db = createServerClient()

  // Setting (not clearing): the target must be a manual sequence that
  // belongs to this location — never let one location point at
  // another's sequence.
  if (seqId) {
    const { data: seq } = await db
      .from('email_sequences')
      .select('id, location_id, trigger_type')
      .eq('id', seqId)
      .maybeSingle()
    if (!seq || seq.location_id !== g.locationId) {
      return NextResponse.json({ success: false, error: 'That sequence is not available at this location.' }, { status: 400 })
    }
    if (seq.trigger_type !== 'manual') {
      return NextResponse.json({ success: false, error: 'The dunning sequence must be a manual-enrol sequence.' }, { status: 400 })
    }
  }

  const { error } = await db
    .from('locations')
    .update({ dunning_sequence_id: seqId })
    .eq('id', g.locationId)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { dunning_sequence_id: seqId } })
}
