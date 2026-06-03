// FLOW-GRAPH Phase 2 (PR3b) — tree model for branch authoring. A flow with
// branches is a TREE of lanes: a lane is an ordered list of items; a branch
// item carries two sub-lanes (yes/no). Editing operates on this tree; it
// compiles back to the flat {nodes,edges} graph. Re-convergent graphs (a
// diamond where two lanes merge) are NOT pure trees and stay read-only.
//
// Tree item shapes:
//   step:   { id, type, config }
//   branch: { id, type:'branch', config:{predicate}, yes:Lane, no:Lane }
import { TRIGGER_SOURCE_ID } from './schema.js'

/** Flat graph → { ok, tree } | { ok:false } (re-convergent / not a tree). */
export function graphToTree(graph) {
  const byId = new Map((graph?.nodes || []).map(n => [n.id, n]))
  const edges = graph?.edges || []
  const out = (id) => edges.filter(e => e.from === id)
  const firstTo = (id) => { const e = out(id)[0]; return e ? e.to : null }
  const labelTo = (id, l) => { const e = out(id).find(x => x.label === l); return e ? e.to : null }
  const visited = new Set()
  let bad = false

  function lane(start) {
    const items = []
    let cur = start
    while (cur != null) {
      if (!byId.has(cur)) break
      if (visited.has(cur)) { bad = true; break }
      visited.add(cur)
      const node = byId.get(cur)
      if (node.type === 'branch') {
        items.push({ id: cur, type: 'branch', config: node.config || {}, yes: lane(labelTo(cur, 'yes')), no: lane(labelTo(cur, 'no')) })
        cur = null
      } else {
        items.push({ id: cur, type: node.type, config: node.config || {} })
        cur = firstTo(cur)
      }
    }
    return items
  }

  const tree = lane(firstTo(TRIGGER_SOURCE_ID))
  return bad ? { ok: false } : { ok: true, tree }
}

/** Nested lane tree → flat graph. Branch sub-lanes become labelled edges; an
 *  empty lane simply has no entry edge (validateGraph then flags it). */
export function treeToGraph(trigger, tree, version = 1) {
  const nodes = []
  const edges = []

  function emit(lane, fromId, label) {
    let prevFrom = fromId
    let prevLabel = label
    for (const item of (lane || [])) {
      nodes.push(item.type === 'branch'
        ? { id: item.id, type: 'branch', config: item.config || {} }
        : { id: item.id, type: item.type, config: item.config || {} })
      edges.push(prevLabel ? { from: prevFrom, to: item.id, label: prevLabel } : { from: prevFrom, to: item.id })
      if (item.type === 'branch') {
        emit(item.yes, item.id, 'yes')
        emit(item.no, item.id, 'no')
        prevFrom = null
        prevLabel = undefined
      } else {
        prevFrom = item.id
        prevLabel = undefined
      }
    }
  }

  emit(tree, TRIGGER_SOURCE_ID, undefined)
  return { version, trigger: trigger || { type: 'manual', config: {} }, nodes, edges }
}

/** Every node id across a tree (for fresh-id generation + counting). */
export function flattenTreeIds(tree) {
  const ids = []
  for (const item of (tree || [])) {
    ids.push(item.id)
    if (item.type === 'branch') ids.push(...flattenTreeIds(item.yes), ...flattenTreeIds(item.no))
  }
  return ids
}

/** Can this graph be edited as a tree? (pure tree, no re-convergence, no orphans) */
export function isPureTree(graph) {
  const r = graphToTree(graph)
  if (!r.ok) return false
  return flattenTreeIds(r.tree).length === (graph?.nodes?.length || 0)
}
