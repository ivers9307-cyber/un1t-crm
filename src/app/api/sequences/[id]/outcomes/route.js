// GET /api/sequences/[id]/outcomes — SEQOUTCOME.1: what people did in the 7
// days after clicking one of an automation's emails, against those sent its
// emails who never opened or clicked one (sequence_outcome_stats, mig 876).
// Same gates as /stats: manager+ and the builder's rule at the sequence's
// studio; another studio's sequence is 404.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { canBuildSequencesAt, canBuildSequencesSomewhere, sequencePermissionRequired, sequenceNotFound } from '@/lib/sequence-access'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const num = (v) => Number(v || 0)

export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!canBuildSequencesSomewhere(user)) return sequencePermissionRequired()
  if (!uuidLike.safeParse(params?.id).success) return sequenceNotFound()

  const { data: seq, error: seqErr } = await db.from('email_sequences').select('id, location_id').eq('id', params.id).maybeSingle()
  if (seqErr) return NextResponse.json({ success: false, error: 'Could not read the automation.' }, { status: 500 })
  if (!seq) return sequenceNotFound()
  const guard = assertLocationAccessOr404(user, seq.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, seq.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!canBuildSequencesAt(user, seq.location_id)) return sequencePermissionRequired()

  const { data, error } = await db.rpc('sequence_outcome_stats', { p_sequence_id: seq.id, p_window_days: 7 })
  if (error) {
    logError('sequence-outcomes', 'outcome read failed', { sequenceId: seq.id, err: error })
    return NextResponse.json({ success: false, error: 'Could not read the results.' }, { status: 500 })
  }
  const pick = (cohort) => {
    const r = (data || []).find((x) => x.cohort === cohort) || {}
    return {
      contacts: num(r.contacts),
      event_registrations: num(r.event_registrations),
      class_attendances: num(r.class_attendances),
      purchases: num(r.purchases),
      purchase_cents: num(r.purchase_cents),
    }
  }
  return NextResponse.json({ success: true, data: { window_days: 7, clicked: pick('clicked'), not_opened: pick('not_opened') } })
})
