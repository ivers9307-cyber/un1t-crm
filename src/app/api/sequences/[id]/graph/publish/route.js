import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { canBuildSequencesAt, canBuildSequencesSomewhere, sequencePermissionRequired, sequenceNotFound } from '@/lib/sequence-access'
import { validateBody } from '@/lib/validate'
import { publishSequence } from '@/lib/sequences/publish'

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

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canBuildSequencesSomewhere(user)) return sequencePermissionRequired()

  const db = createServerClient()
  const { data: existing } = await db.from('email_sequences')
    .select('location_id, graph, draft_graph').eq('id', params.id).single()
  if (!existing) return sequenceNotFound()
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard
  // SEQROUTEGATE.1 — the builder's rule (email or whatsapp) at the sequence.
  if (!canBuildSequencesAt(user, existing.location_id)) return sequencePermissionRequired()

  // Publish the graph in the request body, else the saved draft, else the
  // already-published graph (republish).
  const validation = await validateBody(request, PublishSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data
  const result = await publishSequence(db, { sequenceId: params.id, graph: body?.graph, existing })
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, ...(result.issues ? { issues: result.issues } : {}) },
      { status: result.status },
    )
  }

  return NextResponse.json({ success: true, steps: result.steps })
}
