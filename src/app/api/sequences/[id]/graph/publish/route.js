import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { compileForPublish } from '@/lib/sequences/graph/persist'
import { parseGraphShape } from '@/lib/sequences/graph/schema'
import { validateBody } from '@/lib/validate'

// Permissive — graph is a free-form object validated by compileForPublish.
const PublishSchema = z.object({
  graph: z.any().optional(),
}).passthrough()

// FLOW-GRAPH Phase 2 — POST /api/sequences/[id]/graph/publish
// Promote a graph to the live sequence: validate → compile → replace
// sequence_steps → store the published graph + clear the draft. The runner is
// step_order-driven (scheduler.js: targetOrder = current_step_order + 1), so
// replacing the rows is safe for in-flight enrollments and matches how the
// legacy per-step editor already saves.
//
// Atomicity note: the step replace is delete-then-batch-insert, not a single
// transaction (Supabase-js has no multi-statement tx). The window is one round
// trip and the insert is one all-or-nothing call; an insert failure returns 500
// and the operator republishes. If this ever needs to be bulletproof, move the
// replace into a SECURITY DEFINER RPC. Trigger columns are intentionally left
// to PUT /api/sequences/[id] (it owns webhook-token generation).

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: existing } = await db.from('email_sequences')
    .select('location_id, graph, draft_graph').eq('id', params.id).single()
  if (!existing) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  // Publish the graph in the request body, else the saved draft, else the
  // already-published graph (republish).
  const validation = await validateBody(request, PublishSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data
  const graph = body?.graph ?? existing.draft_graph ?? existing.graph
  if (!graph) {
    return NextResponse.json({ success: false, error: 'Nothing to publish — no graph or draft on this sequence' }, { status: 400 })
  }

  const result = compileForPublish(graph)
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: 'Flow has problems that must be fixed before publishing', issues: result.errors },
      { status: 422 },
    )
  }

  // Replace the runner's steps. delete-all → batch insert the compiled rows.
  const { error: delError } = await db.from('sequence_steps').delete().eq('sequence_id', params.id)
  if (delError) return NextResponse.json({ success: false, error: delError.message }, { status: 500 })

  if (result.steps.length) {
    const rows = result.steps.map(s => ({ ...s, sequence_id: params.id }))
    const { error: insError } = await db.from('sequence_steps').insert(rows)
    if (insError) return NextResponse.json({ success: false, error: insError.message }, { status: 500 })
  }

  // Promote the graph to canonical + clear the draft + GO LIVE. Setting
  // status='active' is what actually makes the sequence run: both the
  // enrolment triggers (lib/sequences/triggers.js) and the runner
  // (scheduler.js) gate on status='active', so a published-but-still-'draft'
  // sequence would materialise steps yet never enrol anyone. Store the
  // normalised graph shape so the column stays clean (defaults applied).
  const { error: seqError } = await db.from('email_sequences')
    .update({ graph: parseGraphShape(graph).data, draft_graph: null, status: 'active' })
    .eq('id', params.id)
  if (seqError) return NextResponse.json({ success: false, error: seqError.message }, { status: 500 })

  return NextResponse.json({ success: true, steps: result.steps.length })
}
