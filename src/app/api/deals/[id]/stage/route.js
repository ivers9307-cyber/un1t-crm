// POST /api/deals/[id]/stage — manual stage move on a MANUAL board.
//
// WAITLIST.2. PUT /api/deals/[id] already resolves a location-scoped stage and
// fires the STAGETRIG.1 sequence trigger, but it is gated by
// authenticateApiKey() (src/lib/api-auth.js) — a Bearer API key, the n8n
// integration path. A browser cannot call it, so it cannot back drag-drop.
// This is its session-authed sibling.
//
// Authorization: session + the `pipeline` permission (the same gate as the
// board), THEN an explicit in-location check on the deal. The service-role
// client bypasses RLS, so this chain IS the access control (repo invariant),
// and an unknown or out-of-scope id answers 404 rather than 403 so ids cannot
// be enumerated.
//
// It REFUSES a derived pipeline. FUNNEL.1 removed drag-drop from the derived
// board because the classifier (webhook + nightly cron) owns every column
// there; accepting a move would hand the operator a card that walks back
// overnight, which is the exact failure that removal prevented. mode='manual'
// is the fence (mig 594) and this is where the API honours it.
//
// The target stage must also live on the deal's OWN board, not merely its own
// location: Hatch runs two boards at one location, so a location filter alone
// would let a waitlist card be parked in a gym column.
//
// stage_entered_at needs no code here — mig 458's trg_deal_stage_entered
// BEFORE-UPDATE trigger stamps it on any stage_id change, from any writer.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const StageMoveSchema = z.object({ stage_id: uuidLike })

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
  if (!hasPermission(user, 'pipeline')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, StageMoveSchema)
  if (!validation.ok) return validation.response
  const { stage_id: stageId } = validation.data

  const db = createServerClient()

  const { data: deal } = await db
    .from('deals')
    .select('id, location_id, contact_id, stage_id, pipeline_id')
    .eq('id', id)
    .maybeSingle()
  if (!deal) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, deal.location_id)
  if (guard) return guard

  // Same BOARD, not just the same location — see the header note.
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id, slug, pipeline_id')
    .eq('id', stageId)
    .eq('pipeline_id', deal.pipeline_id)
    .maybeSingle()
  if (!stage) {
    return NextResponse.json(
      { success: false, error: 'unknown_stage_for_pipeline' },
      { status: 400 },
    )
  }

  // The fence. Note the shape: a pipeline row that fails to resolve is refused
  // too, rather than treated as "not derived, so fine" — an unreadable board is
  // not evidence that hand-moving its cards is safe.
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id, mode, key')
    .eq('id', deal.pipeline_id)
    .maybeSingle()
  if (!pipeline || pipeline.mode !== 'manual') {
    return NextResponse.json({ success: false, error: 'pipeline_is_derived' }, { status: 400 })
  }

  // Dropping a card back where it started is an operator slip, not an error.
  // Answering success (and writing nothing) keeps a mis-drop from re-firing the
  // sequence trigger or filling the audit log with moves that never happened.
  if (stage.id === deal.stage_id) {
    return NextResponse.json({ success: true, data: { moved: false, stage_id: stage.id } })
  }

  const { error: moveErr } = await db.from('deals').update({ stage_id: stage.id }).eq('id', id)
  if (moveErr) {
    return NextResponse.json({ success: false, error: moveErr.message }, { status: 500 })
  }

  // STAGETRIG.1 — a manual move is a real pipeline stage change, and the
  // mig-155 trigger re-derives contacts.pipeline_stage_slug inside the database
  // where the sequence engine never hears it. Best-effort and after the write:
  // the move is already saved, so nothing here may fail the response.
  try {
    const { data: fromStage } = await db
      .from('pipeline_stages')
      .select('slug')
      .eq('id', deal.stage_id)
      .maybeSingle()
    const { triggerSequencesForDealPlacement } = await import('@/lib/sequences/triggers')
    await triggerSequencesForDealPlacement(deal.contact_id, {
      action: 'move',
      from_slug: fromStage?.slug ?? null,
      to_slug: stage.slug,
    })
  } catch (e) {
    logWarn('deals.stage', `pipeline_stage_change trigger failed for deal ${id}`, { err: e })
  }

  // Actor attribution. The deals trigger logs "Pipeline: moved to …" with no
  // user context, so on a board where EVERY move is a human decision "who moved
  // this card?" would otherwise be unanswerable. logAuditEvent swallows its own
  // errors, so this can never fail the already-saved move.
  await logAuditEvent({
    category: 'business',
    action: 'pipeline.manual_move',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    // Deals aren't profiles — identity goes in resource, never target.id.
    target: { label: stage.slug, resource: `deals/${id}` },
    locationId: deal.location_id,
    details: { pipeline: pipeline.key, from_stage_id: deal.stage_id, to_stage_id: stage.id },
    request,
  })

  return NextResponse.json({ success: true, data: { moved: true, stage_id: stage.id } })
}
