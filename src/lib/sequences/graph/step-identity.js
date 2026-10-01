// STEPATTRIB.1 — keep sequence_steps rows' ids across a graph publish.
//
// A publish used to delete every step row and insert the compiled ones.
// email_sends.sequence_step_id is ON DELETE SET NULL (mig 005), so each publish
// orphaned the step of every earlier send and the Performance panel (which keys
// on the step row id) emptied. Now a row is matched to the graph node it was
// compiled from and updated IN PLACE (mig 695's publish_sequence_steps): kept
// nodes keep their row, new nodes insert, removed nodes are deleted (their
// sends SET NULL, as before). Forward only (Richard, 1 Oct 2026): nothing here
// re-attributes a send that already lost its step.
//
// The identity is sequence_steps.graph_node_id. Rows written before mig 695
// carry NULL; they are ADOPTED at their sequence's next publish when the
// stored published graph, compiled, reproduces them at their step_order (the
// fingerprint below). A row that does not match (edited by a legacy step
// route, or hand-patched) is replaced exactly as before. Pure: no IO.
import { compileGraphToSteps } from './compile.js'

/** The step-row columns the plan reads. The publish route selects these (as a
 *  literal, so check:select-columns can read it; its test pins the two equal). */
export const STEP_IDENTITY_COLUMNS = [
  'id', 'step_order', 'step_type', 'graph_node_id',
  'subject', 'html_content', 'template_id', 'whatsapp_template_id',
  'whatsapp_variables', 'whatsapp_header_media_url', 'sms_body',
  'delay_days', 'delay_hours', 'delay_minutes', 'config',
].join(', ')

const TEXT_COLUMNS = ['subject', 'html_content', 'template_id', 'whatsapp_template_id', 'whatsapp_header_media_url', 'sms_body']
const DELAY_COLUMNS = ['delay_days', 'delay_hours', 'delay_minutes']

/** JSON with sorted keys and undefined dropped: jsonb hands keys back reordered. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter(k => value[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Would `compiled` (one row of a compile) have been written as `row`? */
function reproduces(compiled, row) {
  if (compiled.step_type !== row.step_type) return false
  for (const c of TEXT_COLUMNS) if ((compiled[c] ?? null) !== (row[c] ?? null)) return false
  for (const c of DELAY_COLUMNS) if (Number(compiled[c] ?? 0) !== Number(row[c] ?? 0)) return false
  if (canonical(compiled.whatsapp_variables ?? {}) !== canonical(row.whatsapp_variables ?? {})) return false
  return canonical(compiled.config ?? {}) === canonical(row.config ?? {})
}

/** node id → existing row, for rows from before mig 695 (graph_node_id NULL). */
function adoptLegacyRows(existingRows, previousGraph, taken) {
  const adopted = new Map()
  if (!previousGraph) return adopted
  let previous
  try {
    previous = compileGraphToSteps(previousGraph, { withNodeIds: true })
  } catch {
    return adopted // an unreadable stored graph adopts nothing; the publish still replaces
  }
  const legacyByOrder = new Map()
  for (const row of existingRows) {
    if (row.graph_node_id != null) continue
    const list = legacyByOrder.get(row.step_order) || []
    list.push(row)
    legacyByOrder.set(row.step_order, list)
  }
  for (const prev of previous) {
    if (taken.has(prev.graph_node_id) || adopted.has(prev.graph_node_id)) continue
    const candidates = legacyByOrder.get(prev.step_order) || []
    if (candidates.length !== 1) continue
    if (reproduces(prev, candidates[0])) adopted.set(prev.graph_node_id, candidates[0])
  }
  return adopted
}

/**
 * Decide which existing row each compiled row updates.
 * @param compiled rows from compileGraphToSteps(graph, { withNodeIds: true })
 * @param existingRows the sequence's current sequence_steps rows (STEP_IDENTITY_COLUMNS)
 * @param previousGraph email_sequences.graph as stored before this publish (or null)
 * @returns {{ steps: Array, removed: string[], kept: number, inserted: number, adopted: number }}
 *   `steps` are the compiled rows, each with `id` when it updates that row in place.
 */
export function planStepPublish({ compiled, existingRows = [], previousGraph = null }) {
  const byNode = new Map()
  for (const row of existingRows) {
    if (row.graph_node_id != null && !byNode.has(row.graph_node_id)) byNode.set(row.graph_node_id, row)
  }
  const legacy = adoptLegacyRows(existingRows, previousGraph, byNode)
  for (const [node, row] of legacy) byNode.set(node, row)

  const used = new Set()
  let adopted = 0
  const steps = compiled.map((step) => {
    const row = byNode.get(step.graph_node_id)
    if (!row || used.has(row.id) || row.step_type !== step.step_type) return { ...step }
    used.add(row.id)
    if (legacy.get(step.graph_node_id) === row) adopted += 1
    return { ...step, id: row.id }
  })
  const removed = existingRows.filter(r => !used.has(r.id)).map(r => r.id)
  return { steps, removed, kept: used.size, inserted: steps.length - used.size, adopted }
}
