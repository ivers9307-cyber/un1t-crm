// FLOW-GRAPH Phase 2 (PR3) — pure helpers for editing a LINEAR flow. The editor
// models a linear flow as an ordered list of nodes and rebuilds the edge chain
// on every change (trigger -> n1 -> n2 -> ...), which is far less error-prone
// than surgical edge edits. Branchy graphs are not edited here (the builder
// falls back to read-only) — isLinearGraph is the guard.
import { TRIGGER_SOURCE_ID } from './schema.js'

/** Node objects in flow order, following single out-edges from the trigger. */
export function linearOrder(graph) {
  if (!graph) return []
  const byId = new Map((graph.nodes || []).map(n => [n.id, n]))
  const edges = graph.edges || []
  const firstTo = (id) => {
    const e = edges.find(x => x.from === id)
    return e ? e.to : null
  }
  const order = []
  const seen = new Set()
  let cur = firstTo(TRIGGER_SOURCE_ID)
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    order.push(byId.get(cur))
    cur = firstTo(cur)
  }
  return order
}

/** True when the graph is a single unbroken chain with no branch nodes. */
export function isLinearGraph(graph) {
  const nodes = graph?.nodes || []
  if (nodes.some(n => n.type === 'branch')) return false
  return linearOrder(graph).length === nodes.length
}

/** Edge chain trigger -> nodes[0] -> nodes[1] -> ... for an ordered node list. */
export function rebuildLinearEdges(orderedNodes) {
  const edges = []
  let prev = TRIGGER_SOURCE_ID
  for (const n of (orderedNodes || [])) {
    edges.push({ from: prev, to: n.id })
    prev = n.id
  }
  return edges
}

/** Assemble a complete linear graph from a trigger + ordered node list. */
export function toLinearGraph(trigger, orderedNodes, version = 1) {
  return {
    version,
    trigger: trigger || { type: 'manual', config: {} },
    nodes: orderedNodes || [],
    edges: rebuildLinearEdges(orderedNodes || []),
  }
}

/** A fresh, collision-free node id (`n<max+1>`). */
export function nextNodeId(nodes) {
  let max = 0
  for (const n of (nodes || [])) {
    const m = /^n(\d+)$/.exec(n.id || '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${max + 1}`
}

/** Sensible starting config per node type (waits seed a non-zero delay so a
 *  freshly-added wait isn't immediately invalid). */
export function defaultConfigForType(type) {
  switch (type) {
    case 'wait': return { days: 1, hours: 0, minutes: 0 }
    case 'email': return { subject: '', html_content: '' }
    case 'sms': return { body: '' }
    case 'whatsapp': return { template_id: '' }
    case 'apply_tag': return { tag: '' }
    case 'update_field': return { field: '', value: '' }
    case 'internal_task': return { subject: '', note: '' }
    case 'webhook': return { url: '', method: 'POST' }
    case 'move_pipeline_stage': return { stage_slug: '' }
    default: return {}
  }
}
