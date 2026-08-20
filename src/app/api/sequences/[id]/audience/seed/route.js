// AUDIENCEMATCH.1 — the one deliberate act that lets a sequence enrol its own
// audience.
//
//   POST   /api/sequences/[id]/audience/seed  { confirm_count: 2480 }
//   DELETE /api/sequences/[id]/audience/seed
//
// POST enrols NOBODY. Its entire effect is to stamp audience_seeded_at, which
// the */5 sweep (cron-triggers.js runAudienceMatchTriggers) refuses to run
// without. Enrolment stays on the cron, paced and capped, so this route cannot
// itself become the thing that writes 2,000 irreversible rows inside one HTTP
// request that might time out halfway.
//
// WHY confirm_count IS AN EXACT MATCH, NOT A CHECKBOX
// sequence_enrollments has a FULL unique index on (sequence_id, contact_id), so
// an enrolment cannot be undone and re-run. The count is the value that can
// silently be wrong — a filter edited last Tuesday, a Glofox sync overnight —
// so the confirmation makes the operator read THAT number rather than click a
// button they have clicked before. A stale figure is refused with the fresh one
// (409), which is the case this exists to catch: "I previewed 2,480 last week,
// the audience has since widened, click".
//
// The recount uses buildEligibleAudienceQuery — the same builder the preview,
// the count route and the sweep all use — so the number confirmed here and the
// set the sweep enrols cannot drift apart by construction.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'
import { InvalidAudienceFilterError } from '@/lib/audience-filter'
import { selectAll } from '@/lib/select-all'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A ceiling on what one confirmation can authorise. Not a business rule about
// audience size — a blast radius. Above this, whatever the operator thinks they
// are doing is not what they are doing, and the right answer is a conversation
// rather than a bigger number in a dialog.
export const AUDIENCE_SEED_MAX = 10000

const Body = z.object({
  confirm_count: z.number().int().min(0),
})

async function loadSequence(db, id) {
  const { data, error } = await db
    .from('email_sequences')
    .select('id, location_id, name, trigger_type, status, audience_filter, audience_seeded_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

/** Recount, server-side, using the builder the sweep will use. */
async function countMatching(db, seq) {
  const { query } = await buildEligibleAudienceQuery({
    db, channel: null, filter: seq.audience_filter, locationId: seq.location_id, columns: 'id',
  })
  const rows = await selectAll((from, to) => query.order('id').range(from, to))
  return rows.length
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  // Starting a mass enrolment is an owner/manager act, not a general email one.
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const seq = await loadSequence(db, params.id)
  if (!seq) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, seq.location_id)
  if (guard) return guard

  if (seq.trigger_type !== 'audience_match') {
    return NextResponse.json({
      success: false,
      error: 'This automation is not set to enrol everyone matching its audience. Change its trigger first.',
    }, { status: 400 })
  }

  // Same refusal as the sweep's, made here so the operator hears it while they
  // are looking at the thing rather than via a silent no-op on the next tick.
  // `{logic:'and',filters:[]}` is the builder's DEFAULT, so an empty filter is
  // what a half-built sequence looks like, not what "everyone" looks like.
  const filters = seq.audience_filter?.filters
  if (!Array.isArray(filters) || filters.length === 0) {
    return NextResponse.json({
      success: false,
      error: 'Set at least one audience condition first — an empty audience would enrol every contact at this location.',
    }, { status: 400 })
  }

  let actual
  try {
    actual = await countMatching(db, seq)
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }

  if (actual > AUDIENCE_SEED_MAX) {
    return NextResponse.json({
      success: false,
      error: `${actual.toLocaleString()} people match — more than this can start in one go (${AUDIENCE_SEED_MAX.toLocaleString()}). Narrow the audience.`,
      data: { matching: actual, max: AUDIENCE_SEED_MAX },
    }, { status: 400 })
  }

  if (validation.data.confirm_count !== actual) {
    return NextResponse.json({
      success: false,
      error: `The audience has changed since you last looked — ${actual.toLocaleString()} people now match, not ${validation.data.confirm_count.toLocaleString()}. Have a read of the new number and confirm again if it still looks right.`,
      data: { matching: actual, confirmed: validation.data.confirm_count },
    }, { status: 409 })
  }

  // Judge the rows touched, not just the absence of an error: a zero-row UPDATE
  // is not an error in PostgREST, and reporting "started" on a write that
  // matched nothing would leave the operator believing a mass enrolment is
  // under way when the sweep will never run.
  const { data: updated, error: updErr } = await db
    .from('email_sequences')
    .update({
      audience_seeded_at: new Date().toISOString(),
      audience_seeded_by: user.id,
      audience_seed_count: actual,
    })
    .eq('id', seq.id)
    .select('id')
  if (updErr) throw new Error(`seed failed: ${updErr.message}`)
  if (!updated?.length) {
    return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    data: {
      matching: actual,
      seeded_at: new Date().toISOString(),
      // The operator asked "when will this finish" and deserves a real answer.
      approx_minutes: Math.ceil(actual / 50) * 5,
    },
  })
}

// Stop auto-enrolling. Nobody new is swept in; everyone already enrolled keeps
// going through the sequence. Pausing the sequence is the bigger hammer and is
// a different button — the two have genuinely different blast radii.
export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const seq = await loadSequence(db, params.id)
  if (!seq) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, seq.location_id)
  if (guard) return guard

  const { data: updated, error } = await db
    .from('email_sequences')
    .update({ audience_seeded_at: null, audience_seeded_by: null, audience_seed_count: null })
    .eq('id', seq.id)
    .select('id')
  if (error) throw new Error(`clear seed failed: ${error.message}`)
  if (!updated?.length) {
    return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data: { seeded_at: null } })
}
