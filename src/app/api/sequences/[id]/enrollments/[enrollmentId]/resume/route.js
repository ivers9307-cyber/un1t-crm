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
//
// withAuth signs the caller in (its 401 'Unauthorized'; this route said
// 'Unauthorised') and asks for `email` somewhere with the same 403 text; the
// ids (404), the sequence (404), its studio (404) and `email` there (403)
// follow in their old order.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { sequenceNotFound } from '@/lib/sequence-access'
import { logError } from '@/lib/log'
import { uuidLike } from '@/lib/schemas'
import { buildResumePatch, classifyResumeOutcome } from '@/lib/sequences/resume'

export const runtime = 'nodejs'

export const POST = withAuth({
  permission: null,
  location: false,
  allow: (user) => hasPermissionAtAnyLocation(user, 'email'),
  forbiddenMessage: 'Email permission required',
}, async ({ user, db, params }) => {  if (!uuidLike.safeParse(params.enrollmentId).success) {
    return NextResponse.json({ success: false, error: 'Enrollment not found' }, { status: 404 })
  }

  // SEQPAGEGATE.1 — a missing sequence and another studio's answer the same
  // 404 (was 404 vs 403, which confirmed the id existed). A failed read is a
  // logged 500, not "not found"; a garbage id is not found without a read.
  if (!uuidLike.safeParse(params.id).success) return sequenceNotFound()
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

  // SEQPAUSE.1 — the row's own next_step_at is kept when it is later than now
  // (a step paused mid-send already holds the following step's time).
  const { data: current, error: currentErr } = await db
    .from('sequence_enrollments')
    .select('next_step_at')
    .eq('id', params.enrollmentId)
    .eq('sequence_id', params.id)
    .maybeSingle()
  if (currentErr) {
    logError('sequences', 'resume: enrolment read failed', { sequenceId: params.id, code: currentErr.code || null })
    return NextResponse.json({ success: false, error: 'Could not load the enrolment' }, { status: 500 })
  }

  // CAS: only a currently-paused enrollment (scoped to THIS sequence)
  // transitions. Zero rows back means gone or already resumed.
  const { data: updated, error } = await db
    .from('sequence_enrollments')
    .update(buildResumePatch(new Date(), current?.next_step_at ?? null))
    .eq('id', params.enrollmentId)
    .eq('sequence_id', params.id)
    .eq('status', 'paused')
    .select('id, status, next_step_at')
    .maybeSingle()
  if (error) {
    logError('sequences', 'resume: write failed', { sequenceId: params.id, enrollmentId: params.enrollmentId, code: error.code || null })
    return NextResponse.json({ success: false, error: 'Could not resume the enrolment. Try again.' }, { status: 500 })
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
})
