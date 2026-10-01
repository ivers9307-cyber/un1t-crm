import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { canBuildSequencesAt, canBuildSequencesSomewhere, sequencePermissionRequired, sequenceNotFound } from '@/lib/sequence-access'
import { compileForPublish } from '@/lib/sequences/graph/persist'
import { parseGraphShape } from '@/lib/sequences/graph/schema'
import { compileGraphToSteps } from '@/lib/sequences/graph/compile'
import { planStepPublish } from '@/lib/sequences/graph/step-identity'
import { validateBody } from '@/lib/validate'
import { logWarn } from '@/lib/log'

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
// (sequence_steps.graph_node_id, mig 695): a kept node keeps its row id, a new
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

// Same-file literal so check:select-columns resolves it; the route test pins
// it to STEP_IDENTITY_COLUMNS (what the plan compares).
const STEP_ROW_SELECT = 'id, step_order, step_type, graph_node_id, subject, html_content, template_id, whatsapp_template_id, whatsapp_variables, whatsapp_header_media_url, sms_body, delay_days, delay_hours, delay_minutes, config'

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
  const graph = body?.graph ?? existing.draft_graph ?? existing.graph
  if (!graph) {
    return NextResponse.json({ success: false, error: 'Nothing to publish — no graph or draft on this sequence' }, { status: 400 })
  }

  // SEQ-URLBUTTON.1 — the URL-button rule needs the TEMPLATE, and the graph
  // carries only an id. Load this location's rows (scoped to the sequence's own
  // location, so another tenant's template can never satisfy the check) and only
  // when a WhatsApp step actually names one — most flows have none.
  const waTemplateIds = [...new Set(
    (parseGraphShape(graph).data?.nodes || [])
      .filter(n => n?.type === 'whatsapp')
      .map(n => n.config?.template_id ?? n.config?.whatsapp_template_id)
      .filter(Boolean),
  )]
  let whatsappTemplates = []
  if (waTemplateIds.length) {
    // A sequence with no location_id reads nothing and the gate is simply off —
    // such a sequence cannot send a WhatsApp step in the first place
    // (resolveApprovedWhatsappTemplate refuses a template from another
    // location), so there is nothing here to protect.
    const { data, error } = await db.from('whatsapp_templates')
      .select('id, name, components')
      .eq('location_id', existing.location_id)
      .in('id', waTemplateIds)
    // Fail open — a template read that fell over must not block a publish that
    // is otherwise fine. But say so: silently skipping the gate is how it would
    // come to look like the gate never worked.
    if (error) {
      logWarn('sequences', 'publish: whatsapp_templates read failed, URL-button gate skipped', { sequenceId: params.id, err: error.message })
    }
    whatsappTemplates = data || []
  }

  const result = compileForPublish(graph, { whatsappTemplates })
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: 'Flow has problems that must be fixed before publishing', issues: result.errors },
      { status: 422 },
    )
  }

  // STEPATTRIB.1 — which existing row each compiled node updates in place.
  // Rows from before mig 695 carry no node id; the stored PUBLISHED graph
  // (not the draft) is what they were compiled from, so it identifies them.
  const { data: existingRows, error: rowsError } = await db.from('sequence_steps')
    .select(STEP_ROW_SELECT)
    .eq('sequence_id', params.id)
  if (rowsError) return NextResponse.json({ success: false, error: rowsError.message }, { status: 500 })

  const plan = planStepPublish({
    compiled: compileGraphToSteps(graph, { withNodeIds: true }),
    existingRows: existingRows || [],
    previousGraph: existing.graph,
  })
  const { error: stepsError } = await db.rpc('publish_sequence_steps', {
    p_sequence_id: params.id,
    p_steps: plan.steps,
  })
  if (stepsError) return NextResponse.json({ success: false, error: stepsError.message }, { status: 500 })

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
