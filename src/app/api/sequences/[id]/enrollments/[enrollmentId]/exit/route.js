// POST /api/sequences/[id]/enrollments/[enrollmentId]/exit
//
// SEQGAPS.1 — the operator's manual override. SEQEXIT.1 gave the engine two
// automatic exits (the goal → 'goal_met', the audience → 'left_audience');
// this is what a human reaches for when neither fires and this contact
// should simply stop hearing from the sequence. Writes
// exit_reason='manual_exit' so the funnel keeps telling the truth about WHY
// people left.
//
// Honest bound on what this cancels: the scheduler ticks every ~5 minutes
// and may already be mid-step for this enrolment when the request lands.
// The compare-and-set below makes the DATABASE state correct — the row is
// exited, next_step_at is null, and no FURTHER step is ever scheduled — but
// a step already handed to Postmark / Meta / Twilio in this tick will still
// be delivered. This route does not recall a send that has left the
// building, and must not be described as if it does.
//
// Irreversible: there is no un-exit. Re-entry is the manual enrol path.
//
// Compare-and-set on status IN ('active','paused') so double-clicks and cron
// races lose cleanly: zero rows updated → 409 (benign — already gone), never
// a 500. Same guard idiom as the sibling /resume route: session auth + email
// permission + location scope on the parent sequence (service-role routes
// get NO RLS — nothing else filters this).

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { buildExitPatch, classifyExitOutcome, EXITABLE_STATUSES } from '@/lib/sequences/exit'

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
  // Verify sequence exists + the caller can see it — mirrors /resume.
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

  // CAS: only a live enrollment (scoped to THIS sequence) transitions.
  // Zero rows back means gone, already exited, or completed.
  const { data: updated, error } = await db
    .from('sequence_enrollments')
    .update(buildExitPatch())
    .eq('id', params.enrollmentId)
    .eq('sequence_id', params.id)
    .in('status', EXITABLE_STATUSES)
    .select('id, status, exit_reason')
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
    const outcome = classifyExitOutcome({ updatedRow: null, currentStatus: existing?.status || null })
    return NextResponse.json({ success: false, error: outcome.error }, { status: outcome.status })
  }

  return NextResponse.json({ success: true, data: updated })
}
