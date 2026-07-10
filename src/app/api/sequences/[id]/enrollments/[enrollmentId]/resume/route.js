// POST /api/sequences/[id]/enrollments/[enrollmentId]/resume
//
// Resume a PAUSED enrollment (auto-paused after MAX_ERRORS consecutive step
// failures, or left paused by an operator). Sets it active + due now with
// the error ledger cleared — the exact shape the scheduler expects (the
// 2026-07-10 comms-audit remediation resumed 11 of these via raw SQL; this
// route is the UI path for next time). Compare-and-set on status='paused'
// so double-clicks and races are safe: 409 when it's no longer paused.
//
// Same guard idiom as /api/sequences/[id]/enrol: session auth + email
// permission + location scope on the parent sequence.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { buildResumePatch, classifyResumeOutcome } from '@/lib/sequences/resume'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
  }
  if (!uuidLike.safeParse(params.enrollmentId).success) {
    return NextResponse.json({ success: false, error: 'Enrollment not found' }, { status: 404 })
  }

  const db = createServerClient()
  // Verify sequence exists + the caller can see it — mirrors /enrol.
  const { data: sequence } = await db
    .from('email_sequences')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!sequence) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const locationIds = getUserLocationIds(user)
  if (user.role !== 'master' && !locationIds.includes(sequence.location_id)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // CAS: only a currently-paused enrollment (scoped to THIS sequence)
  // transitions. Zero rows back means gone or already resumed.
  const { data: updated, error } = await db
    .from('sequence_enrollments')
    .update(buildResumePatch())
    .eq('id', params.enrollmentId)
    .eq('sequence_id', params.id)
    .eq('status', 'paused')
    .select('id, status, next_step_at')
    .maybeSingle()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  if (!updated) {
    const { data: existing } = await db
      .from('sequence_enrollments')
      .select('status')
      .eq('id', params.enrollmentId)
      .eq('sequence_id', params.id)
      .maybeSingle()
    const outcome = classifyResumeOutcome({ updatedRow: null, currentStatus: existing?.status || null })
    return NextResponse.json({ success: false, error: outcome.error }, { status: outcome.status })
  }

  return NextResponse.json({ success: true, data: updated })
}
