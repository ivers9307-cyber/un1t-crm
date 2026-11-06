// PIPEBUILD.4b — publishSequence: the body of POST /api/sequences/[id]/graph/publish,
// lifted out so the recipe installer and the Meta-approval hook can publish a
// sequence from a library too. The route keeps auth / permission / body
// validation; this owns load → template read → compile → in-place step apply
// → promote. Result: { ok: true, steps } or { ok: false, status, error, issues? }.
//
// STEPATTRIB.1 — steps are applied IN PLACE keyed by graph node id
// (publish_sequence_steps, one transaction), never delete-all-and-insert.

import { compileForPublish } from '@/lib/sequences/graph/persist'
import { parseGraphShape } from '@/lib/sequences/graph/schema'
import { compileGraphToSteps } from '@/lib/sequences/graph/compile'
import { planStepPublish } from '@/lib/sequences/graph/step-identity'
import { loadTemplatesForApproval } from '@/lib/sequences/template-approval'
import { logWarn } from '@/lib/log'

// Same-file literal so check:select-columns resolves it; the route test pins
// it to STEP_IDENTITY_COLUMNS (what the plan compares).
const STEP_ROW_SELECT = 'id, step_order, step_type, graph_node_id, subject, html_content, template_id, whatsapp_template_id, whatsapp_variables, whatsapp_header_media_url, sms_body, delay_days, delay_hours, delay_minutes, config'

const fail = (status, error, issues) => (issues ? { ok: false, status, error, issues } : { ok: false, status, error })

/**
 * @param {object} db service-role client
 * @param {{ sequenceId: string, graph?: object, existing?: { location_id, graph, draft_graph } }} opts
 *   `graph` is the optional request-body graph (else the draft, else the
 *   published graph). `existing` lets a caller that already loaded the row
 *   (the route, for its auth checks) skip the second read.
 */
export async function publishSequence(db, { sequenceId, graph: bodyGraph, existing: preloaded } = {}) {
  let existing = preloaded
  if (!existing) {
    const { data, error } = await db.from('email_sequences')
      .select('location_id, graph, draft_graph').eq('id', sequenceId).maybeSingle()
    if (error) return fail(500, error.message)
    existing = data
  }
  if (!existing) return fail(404, 'Not found')

  const graph = bodyGraph ?? existing.draft_graph ?? existing.graph
  if (!graph) return fail(400, 'Nothing to publish — no graph or draft on this sequence')

  // SEQ-URLBUTTON.1 — the URL-button rule needs the TEMPLATE, and the graph
  // carries only an id. Scoped to the sequence's own location.
  const waTemplateIds = [...new Set(
    (parseGraphShape(graph).data?.nodes || [])
      .filter(n => n?.type === 'whatsapp')
      .map(n => n.config?.template_id ?? n.config?.whatsapp_template_id)
      .filter(Boolean),
  )]
  let whatsappTemplates = []
  if (waTemplateIds.length) {
    // PIPEBUILD.1a — fail CLOSED: the read backs the approval rule too.
    const loaded = await loadTemplatesForApproval(db, { locationId: existing.location_id, templateIds: waTemplateIds })
    if (!loaded.ok) {
      logWarn('sequences', 'publish: whatsapp_templates read failed, publish refused', { sequenceId, err: loaded.error?.message || String(loaded.error) })
      return fail(503, 'Could not check the WhatsApp templates just now. Nothing was published.')
    }
    whatsappTemplates = loaded.rows
  }

  const result = compileForPublish(graph, { whatsappTemplates, requireApprovedTemplates: true })
  if (!result.ok) return fail(422, 'Flow has problems that must be fixed before publishing', result.errors)

  // Rows from before mig 698 carry no node id; the stored PUBLISHED graph
  // (not the draft) is what they were compiled from, so it identifies them.
  const { data: existingRows, error: rowsError } = await db.from('sequence_steps')
    .select(STEP_ROW_SELECT)
    .eq('sequence_id', sequenceId)
  if (rowsError) return fail(500, rowsError.message)

  const plan = planStepPublish({
    compiled: compileGraphToSteps(graph, { withNodeIds: true }),
    existingRows: existingRows || [],
    previousGraph: existing.graph,
  })
  const { error: stepsError } = await db.rpc('publish_sequence_steps', {
    p_sequence_id: sequenceId,
    p_steps: plan.steps,
  })
  if (stepsError) return fail(500, stepsError.message)

  // Promote + clear the draft + GO LIVE (status='active' is what makes both
  // the enrolment triggers and the runner pick the sequence up).
  const { error: seqError } = await db.from('email_sequences')
    .update({ graph: parseGraphShape(graph).data, draft_graph: null, status: 'active' })
    .eq('id', sequenceId)
  if (seqError) return fail(500, seqError.message)

  return { ok: true, steps: result.steps.length }
}
