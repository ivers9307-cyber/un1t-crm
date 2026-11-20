import { NextResponse } from 'next/server'
import { z } from 'zod'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { canBuildSequencesAt, canBuildSequencesSomewhere, sequencePermissionRequired, sequenceNotFound } from '@/lib/sequence-access'
import { validateBody } from '@/lib/validate'
import { publishSequence } from '@/lib/sequences/publish'
import { refuseIfFollowupOwned, isRetiredFollowupSequence, retiredFollowupResponse } from '@/lib/followup-owned-sequences'

// Permissive — graph is a free-form object validated by compileForPublish.
const PublishSchema = z.object({
  graph: z.any().optional(),
}).passthrough()

// FLOW-GRAPH Phase 2 — POST /api/sequences/[id]/graph/publish
// Promote a graph to the live sequence: validate → compile → apply the steps
// → store the published graph + clear the draft. The runner is
// step_order-driven (scheduler.js: targetOrder = current_step_order + 1), so
// an in-flight enrolment on step k runs step k+1 of the new graph.
//
// STEPATTRIB.1 — the steps are applied IN PLACE, keyed by graph node id
// (sequence_steps.graph_node_id, mig 698): a kept node keeps its row id, a new
// node inserts, only a removed node's row is deleted. It used to delete every
// row and insert the compiled ones, and email_sends.sequence_step_id is ON
// DELETE SET NULL, so each publish orphaned every earlier send's step (22,771
// of 22,793 on 30 Sep) and the Performance panel's per-step table emptied.
// Forward only (Richard, 1 Oct 2026): sends that already lost their step stay
// NULL. publish_sequence_steps applies the plan in ONE transaction, so a
// runner tick sees the old steps or the new ones, never none (a missing next
// step COMPLETES an enrolment), and a failure changes nothing. Trigger columns
// are intentionally left to PUT /api/sequences/[id] (it owns webhook-token
// generation).

//
// withAuth only signs the caller in; the builder rule anywhere (403), the row
// (404), its studio (404) and the rule there (403) keep their order here. A
// database failure inside the publish is logged and answered with a fixed 500
// (it used to return the error text).
export const POST = withAuth({ permission: null, location: false }, async ({ request, user, db, params }) => {
  if (!canBuildSequencesSomewhere(user)) return sequencePermissionRequired()

  const { data: existing } = await db.from('email_sequences')
    .select('location_id, graph, draft_graph, status, trigger_type, trigger_config').eq('id', params.id).single()
  if (!existing) return sequenceNotFound()
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard
  // SEQROUTEGATE.1 — the builder's rule (email or whatsapp) at the sequence.
  if (!canBuildSequencesAt(user, existing.location_id)) return sequencePermissionRequired()
  const owned = await refuseIfFollowupOwned(db, { id: params.id, location_id: existing.location_id })
  if (owned) return owned
  // PIPEBUILD.5l — publishing sets status 'active': never for a follow-up
  // sequence a board retired (see PUT /api/sequences/[id]).
  if (isRetiredFollowupSequence(existing)) return retiredFollowupResponse()

  // Publish the graph in the request body, else the saved draft, else the
  // already-published graph (republish).
  const validation = await validateBody(request, PublishSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data
  const result = await publishSequence(db, { sequenceId: params.id, graph: body?.graph, existing })
  if (!result.ok) {
    if (result.status === 500) {
      logError('sequences', 'publish failed', { sequenceId: params.id, err: result.error })
      return NextResponse.json({ success: false, error: 'Could not publish the sequence. Try again.' }, { status: 500 })
    }
    return NextResponse.json(
      { success: false, error: result.error, ...(result.issues ? { issues: result.issues } : {}) },
      { status: result.status },
    )
  }

  return NextResponse.json({ success: true, steps: result.steps })
})
