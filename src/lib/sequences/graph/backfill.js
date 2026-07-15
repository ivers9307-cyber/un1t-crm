// FLOW-GRAPH.7 — pure helper: turn sequence rows (with steps) into
// {id, graph} updates, skipping any sequence that already has a graph.
import { decompileStepsToGraph } from './decompile.js'
import { compileGraphToSteps } from './compile.js'

export function buildBackfillUpdates(rows) {
  const out = []
  for (const r of rows || []) {
    if (r.graph) continue
    const trigger = { type: r.trigger_type || 'manual', config: r.trigger_config || {} }
    out.push({ id: r.id, graph: decompileStepsToGraph(r.steps || [], trigger) })
  }
  return out
}

// SEQ-TERMINAL — one-time healing of sequence_steps compiled before the
// compiler stamped config.next_step_order (terminal branch arms fell
// through into the other arm). Recompiles each stored graph and emits a
// per-step config update that ADDS the marker, preserving the row's
// existing config keys. A sequence whose live rows no longer line up
// with its graph (step_type mismatch at any order) is skipped whole and
// reported — republishing from the builder is the fix there, not a
// blind stamp.
export function buildMarkerBackfillUpdates(rows) {
  const updates = []
  const skipped = []
  for (const r of rows || []) {
    if (!r.graph || !(r.steps || []).length) continue
    const compiled = compileGraphToSteps(r.graph)
    const byOrder = new Map(compiled.map(s => [s.step_order, s]))
    const mismatch = (r.steps || []).find(s => byOrder.get(s.step_order)?.step_type !== s.step_type)
    if (mismatch || compiled.length !== r.steps.length) {
      const detail = mismatch
        ? `step_order ${mismatch.step_order} is ${mismatch.step_type}, graph compiles ${byOrder.get(mismatch.step_order)?.step_type ?? 'nothing'}`
        : `graph compiles ${compiled.length} steps, ${r.steps.length} live`
      skipped.push({ id: r.id, reason: `steps diverge from graph — ${detail}` })
      continue
    }
    for (const s of r.steps) {
      if (s.step_type === 'branch') continue
      const marker = byOrder.get(s.step_order).config.next_step_order
      if ((s.config || {}).next_step_order === marker) continue
      updates.push({ sequenceId: r.id, stepId: s.id, config: { ...(s.config || {}), next_step_order: marker } })
    }
  }
  return { updates, skipped }
}
