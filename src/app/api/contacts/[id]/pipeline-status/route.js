// POST /api/contacts/[id]/pipeline-status — operator "Cold" dismissal.
//
// FUNNEL.4 — take a lead off the pipeline ({ cold: true }) or return them to
// it ({ cold: false }). Reserved for a lead not worth selling to / who said
// they're not interested. Sets/clears contacts.pipeline_dismissed_at, then
// re-places the deal immediately (ensureDealForContact runs the classifier)
// so the board reflects the change without waiting for the nightly cron. The
// classifier auto-revives a cold lead the moment they attend a class after
// the dismissal — no un-cold click needed if they simply come back and train.
//
// HATCHCOLD.2 — `location_id` names the board's studio. At the contact's home
// studio (or with no location_id) the stamp is contacts.pipeline_dismissed_at;
// at any other studio it is that studio's contact_pipeline_dismissals row (mig
// 777), and the contact must hold an open deal there.
//
// Authorization: session + `pipeline` permission (same gate as the board),
// THEN an explicit in-location check on the contact. Service-role client
// bypasses RLS, so this guard IS the access control (repo invariant).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { ensureDealForContact } from '@/lib/glofox-sync'
import { reclassifyUn1tBoardNow } from '@/lib/un1t-pipeline-cadence'
import { writeStudioDismissal } from '@/lib/studio-pipeline-dismissal'
import { logPipelineDismissal } from '@/lib/activity-events'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

const PipelineStatusSchema = z.object({
  // true → mark Cold (dismiss); false → return to the pipeline (clear).
  cold: z.boolean(),
  // HATCHCOLD.2 — the studio whose board Cold was pressed on. Omitted = the
  // contact's home studio (the contact page). Never trusted on its own: a
  // studio other than home needs an open deal for this contact there.
  location_id: uuidLike.optional(),
})

// Classifier input columns — must include everything classifyContact reads so
// the immediate re-placement matches what the nightly cron would compute.
const SNAPSHOT_COLS =
  'id, name, location_id, glofox_membership_status, joined_at, created_at, ' +
  'last_attended_at, trial_credits_remaining, recent_bookings, converted_at, ' +
  'pack_customer_at, pipeline_dismissed_at'

export async function POST(request, props) {
  const params = await props.params
  const { id } = params

  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermissionAtAnyLocation(user, 'pipeline')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, PipelineStatusSchema)
  if (!validation.ok) return validation.response
  const { cold, location_id: requestedLocationId } = validation.data

  const db = createServerClient()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select(SNAPSHOT_COLS)
    .eq('id', id)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  // HATCHCOLD.2 — Cold applies on the board it was pressed from. The home
  // studio's Cold is contacts.pipeline_dismissed_at; any other studio's is its
  // own contact_pipeline_dismissals row, which only that studio's board reads.
  const boardLocationId = requestedLocationId || contact.location_id
  const atHome = boardLocationId === contact.location_id

  const guard = assertLocationAccessOr404(user, boardLocationId)
  if (guard) return guard
  // ROLESWEEP.1c — `pipeline` judged at the board's studio, not the active studio.
  if (!hasPermissionForLocation(user, boardLocationId, 'pipeline')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  if (!atHome) {
    // The person must be on this studio's board: an open deal here. 404, not
    // 403, so a studio id cannot be used to probe for contacts.
    const { data: hereDeals, error: hereErr } = await db
      .from('deals')
      .select('id')
      .eq('contact_id', id)
      .eq('location_id', boardLocationId)
      .eq('status', 'open')
      .limit(1)
    if (hereErr) {
      return NextResponse.json({ success: false, error: hereErr.message }, { status: 500 })
    }
    if (!hereDeals?.length) {
      return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
    }
  }

  // now (ISO) when dismissing, null when clearing. Idempotent — setting the
  // same value twice is harmless.
  const dismissedAt = cold ? new Date().toISOString() : null
  if (atHome) {
    const { error: updateErr } = await db
      .from('contacts')
      .update({ pipeline_dismissed_at: dismissedAt })
      .eq('id', id)
    if (updateErr) {
      return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
    }
  } else {
    const { error: studioErr } = await writeStudioDismissal(db, {
      contactId: id, locationId: boardLocationId, dismissedAt, userId: user.id,
    })
    if (studioErr) {
      return NextResponse.json({ success: false, error: studioErr.message }, { status: 500 })
    }
  }

  // Move the deal now so the board updates immediately, mirroring the persisted
  // change. Best-effort: the nightly cron + next webhook sync also converge, so
  // a placement hiccup here is not fatal to the (already-saved) dismissal.
  let deal = null
  try {
    deal = await ensureDealForContact(
      db,
      boardLocationId,
      id,
      { ...contact, pipeline_dismissed_at: dismissedAt },
      contact.name || null,
      // Away from home the deal already exists (checked above); never make one.
      { noCreate: !atHome },
    )
  } catch (e) {
    deal = { action: 'error', error: e?.message || 'deal placement threw' }
  }

  // HATCHCOLD.1 — at a un1t.online studio (Hatch Street) the call above is a
  // no-op: the primary board is the manual Waitlist, and the derived
  // Acquisition board is placed only by the whole-studio pass, so a Cold lead
  // stayed on it until the next hourly run. Run that pass now. It fires its own
  // stage triggers for the moves it lands; a studio with no un1t board returns
  // at once without a pass. Never throws.
  const boardPass = await reclassifyUn1tBoardNow(db, boardLocationId, { userId: user.id })

  // STAGETRIG.1 — a Cold dismissal (or restore) is a real, operator-driven
  // pipeline stage move, and it was invisible to the sequence engine: the
  // pipeline_stage_change trigger only ever ran from contact CREATION. Fires
  // only when ensureDealForContact reports action 'move' with two different
  // slugs, so a re-click that lands on the same stage enrols nobody.
  // Best-effort — the dismissal itself is already saved.
  try {
    const { triggerSequencesForDealPlacement } = await import('@/lib/sequences/triggers')
    await triggerSequencesForDealPlacement(id, deal, {
      dealLocationId: deal?.location_id,
      pipelineId: deal?.pipeline_id,
    })
  } catch {
    // The helper swallows its own errors; this only guards the import.
  }

  // Actor attribution — the deals trigger logs "Pipeline: moved to Cold"
  // with no user context, which made "who dismissed this lead?" unanswerable.
  // Record WHO on the contact timeline + in the unified audit log. Both
  // helpers are best-effort (swallow their own errors) so an attribution
  // hiccup never fails the already-saved dismissal.
  await logPipelineDismissal(db, {
    contactId: id,
    locationId: boardLocationId,
    cold,
    actorName: user.full_name || user.email || null,
  })
  await logAuditEvent({
    category: 'business',
    action: cold ? 'pipeline.dismiss' : 'pipeline.restore',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    // Contacts aren't profiles — identity goes in resource, never target.id.
    target: { label: contact.name || null, resource: `contacts/${id}` },
    locationId: boardLocationId,
    details: { cold, at_home: atHome, deal_action: deal?.action || null, board_pass: boardPass.ran ? 'ran' : boardPass.reason },
    request,
  })

  return NextResponse.json({ success: true, data: { cold, pipeline_dismissed_at: dismissedAt, deal, board_pass: boardPass.ran ? 'ran' : boardPass.reason } })
}
