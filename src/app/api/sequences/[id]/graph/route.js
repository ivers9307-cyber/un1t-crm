import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { resolveSequenceGraph } from '@/lib/sequences/graph/persist'
import { parseGraphShape } from '@/lib/sequences/graph/schema'
import { validateBody } from '@/lib/validate'

// Permissive — graph is a free-form object validated by parseGraphShape.
const GraphDraftSchema = z.object({
  graph: z.any().optional(),
  graph_version: z.number().int().optional(),
}).passthrough()

// FLOW-GRAPH Phase 2 — the graph read/draft surface the builder (and, in
// Phase 3, the AI agent) talks to.
//   GET    → the graph to open (draft → published → decompiled-from-steps)
//   PUT    → save a work-in-progress draft (shape-checked, NOT fully validated;
//            full validation is the publish gate)
//   DELETE → discard the draft (clear draft_graph) so the editor reopens what
//            is actually live — without this a stale draft permanently masks
//            the production automation
// Trigger editing stays on the existing PUT /api/sequences/[id] route (it owns
// the webhook-token lifecycle); publish here only ever touches steps + graph.

async function loadSequence(db, sequenceId) {
  const { data } = await db.from('email_sequences')
    .select('id, location_id, graph, draft_graph, graph_version, trigger_type, trigger_config, sequence_steps(*)')
    .eq('id', sequenceId)
    .single()
  return data
}

// GET /api/sequences/[id]/graph
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const sequence = await loadSequence(db, params.id)
  if (!sequence) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, sequence.location_id)
  if (guard) return guard

  return NextResponse.json({
    success: true,
    graph: resolveSequenceGraph(sequence),
    published_graph: sequence.graph ?? null,
    has_draft: sequence.draft_graph != null,
    is_published: sequence.graph != null,
    graph_version: sequence.graph_version ?? 1,
  })
}

// PUT /api/sequences/[id]/graph — save an unpublished draft.
export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: existing } = await db.from('email_sequences')
    .select('location_id').eq('id', params.id).single()
  if (!existing) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  const validation = await validateBody(request, GraphDraftSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data
  // A draft is allowed to be semantically incomplete (mid-edit), but it must
  // still be a *graph* — reject anything not shaped like one so we never
  // persist garbage into draft_graph.
  const shape = parseGraphShape(body?.graph)
  if (!shape.ok) {
    return NextResponse.json(
      { success: false, error: 'Draft is not a valid flow graph', issues: [shape.error.message] },
      { status: 400 },
    )
  }

  const update = { draft_graph: shape.data }
  if (Number.isInteger(body?.graph_version)) update.graph_version = body.graph_version

  const { error } = await db.from('email_sequences').update(update).eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, saved: 'draft' })
}

// DELETE /api/sequences/[id]/graph — discard the unpublished draft.
export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: existing } = await db.from('email_sequences')
    .select('location_id').eq('id', params.id).single()
  if (!existing) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  const { error } = await db.from('email_sequences').update({ draft_graph: null }).eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, discarded: true })
}
