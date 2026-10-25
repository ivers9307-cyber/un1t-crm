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
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sequenceNotFound } from '@/lib/sequence-access'
import { logError } from '@/lib/log'
import { uuidLike } from '@/lib/schemas'
import { buildResumePatch, classifyResumeOutcome } from '@/lib/sequences/resume'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
  }
  if (!uuidLike.safeParse(params.enrollmentId).success) {
    return NextResponse.json({ success: false, error: 'Enrollment not found' }, { status: 404 })
  }

  // SEQPAGEGATE.1 — a missing sequence and another studio's answer the same
  // 404 (was 404 vs 403, which confirmed the id existed). A failed read is a
  // logged 500, not "not found"; a garbage id is not found without a read.
  if (!uuidLike.safeParse(params.id).success) return sequenceNotFound()
  const db = createServerClient()
  const { data: sequence, error: seqErr } = await db
    .from('email_sequences')
    .select('id, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (seqErr) {
    logError('sequences', 'resume: sequence read failed', { sequenceId: params.id, code: seqErr.code || null })
    return NextResponse.json({ success: false, error: 'Could not load the sequence' }, { status: 500 })
  }
  if (!sequence) return sequenceNotFound()
  const hidden = assertLocationAccessOr404(user, sequence.location_id)
  if (hidden) return hidden
  // ROLESWEEP.1a — the permission is judged at the sequence's location.
  if (!hasPermissionForLocation(user, sequence.location_id, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
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
