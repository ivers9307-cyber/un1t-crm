// POST /api/sequences/[id]/test
//
// Tier 1C — sequence test mode. Enrols the operator's own contact
// row (looked up by their auth email at the sequence's location)
// into the sequence with delays accelerated to seconds. Lets the
// operator preview every message in the sequence within a couple
// of minutes rather than waiting for the configured day-delays.
//
// How acceleration works:
//   - Each step's configured delay is converted to a fixed 60s
//     real-time gap when this enrolment runs. So a 7-day-then-3-
//     day sequence becomes a "1 minute then 2 minutes" sequence
//     for the test. Day-of-week / send-time guards are skipped
//     (they're checked against the original delay, not the
//     accelerated one).
//   - The enrolment row gets metadata.test = true so the runner
//     knows to use accelerated timing. Existing enrolments
//     unaffected.
//
// Operator must have manager+ at the sequence's location. Test
// enrolments don't count toward the sequence's enrolled_count
// stats.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!user.email) {
    return NextResponse.json({ success: false, error: 'Your account has no email — cannot test.' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: sequence } = await db
    .from('email_sequences')
    .select('id, location_id, status')
    .eq('id', params.id)
    .single()
  if (!sequence) {
    return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, sequence.location_id)
  if (guard) return guard

  // Find or create the operator's contact at this location. Reuses
  // the race-contact-linking helper for consistency — it gracefully
  // handles cross-location contacts.
  const operatorContactId = await findOrCreateRaceContact({
    db,
    locationId: sequence.location_id,
    email: user.email,
    name: user.full_name || user.email,
  })
  if (!operatorContactId) {
    return NextResponse.json({
      success: false,
      error: 'Could not resolve your contact row to test against.',
    }, { status: 500 })
  }

  // Insert a test enrolment. metadata.test=true is the only marker —
  // the runner picks it up and applies the accelerated delay.
  const { data: enrolment, error } = await db
    .from('sequence_enrollments')
    .insert({
      sequence_id: sequence.id,
      contact_id: operatorContactId,
      status: 'active',
      next_step_at: new Date(Date.now() + 5_000).toISOString(),
      source_type: 'test',
      source_ref: user.id,
      metadata: { test: true, accelerated_delay_seconds: 60 },
    })
    .select('id')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: {
      enrolment_id: enrolment.id,
      operator_contact_id: operatorContactId,
      message: 'Test enrolment created — first step fires within 60 seconds. Check your email/SMS.',
    },
  })
}
