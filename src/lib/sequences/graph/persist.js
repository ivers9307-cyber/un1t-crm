// FLOW-GRAPH Phase 2 — the persistence seam between the flow graph and the
// runner's sequence_steps. Pure: the route does the IO, these decide *what*
// to read/write. Two jobs:
//   - resolveSequenceGraph: what graph the builder opens (draft → published →
//     lazily-decompiled-from-steps). The decompile branch IS the deferred
//     backfill — sequences predating the graph column reconstruct it on first
//     open instead of a one-time prod write.
//   - compileForPublish: the publish gate — validate, then compile to step rows.
import { decompileStepsToGraph } from './decompile.js'
import { validateGraph } from './validate.js'
import { compileGraphToSteps } from './compile.js'

/**
 * The graph the builder should open for a loaded sequence row.
 * Precedence: unpublished draft → published canonical → decompile live steps.
 * @param sequence email_sequences row incl. sequence_steps[], trigger_type, trigger_config
 * @param opts.preferDraft when false, ignore draft_graph (used for "what is live")
 */
export function resolveSequenceGraph(sequence, { preferDraft = true } = {}) {
  if (!sequence) return null
  if (preferDraft && sequence.draft_graph) return sequence.draft_graph
  if (sequence.graph) return sequence.graph
  // Legacy / never-published: rebuild the graph from the runner's steps.
  const steps = [...(sequence.sequence_steps || [])].sort((a, b) => a.step_order - b.step_order)
  const trigger = {
    type: sequence.trigger_type || 'manual',
    config: sequence.trigger_config || {},
  }
  return decompileStepsToGraph(steps, trigger)
}

/**
 * The publish gate. Validates the graph, then compiles it to sequence_steps
 * rows (without sequence_id — the caller stamps that + does the replace IO).
 * @returns {{ok:false, errors:Array}|{ok:true, steps:Array}}
 */
export function compileForPublish(graph) {
  const v = validateGraph(graph)
  if (!v.ok) return { ok: false, errors: v.errors }
  return { ok: true, steps: compileGraphToSteps(graph) }
}
