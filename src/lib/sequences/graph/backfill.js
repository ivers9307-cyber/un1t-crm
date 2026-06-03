// FLOW-GRAPH.7 — pure helper: turn sequence rows (with steps) into
// {id, graph} updates, skipping any sequence that already has a graph.
import { decompileStepsToGraph } from './decompile.js'

export function buildBackfillUpdates(rows) {
  const out = []
  for (const r of rows || []) {
    if (r.graph) continue
    const trigger = { type: r.trigger_type || 'manual', config: r.trigger_config || {} }
    out.push({ id: r.id, graph: decompileStepsToGraph(r.steps || [], trigger) })
  }
  return out
}
