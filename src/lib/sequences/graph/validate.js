// FLOW-GRAPH.2 — semantic validation of a flow graph. Shared by the
// builder (inline red flags), the agent (self-correct loop), and publish
// (the gate). Pure. Returns { ok, errors: [{ code, nodeId?, message }] }.
import { parseGraphShape, TRIGGER_SOURCE_ID } from './schema.js'

function requiredConfigError(node) {
  const c = node.config || {}
  const need = (cond, msg) => (cond ? null : msg)
  switch (node.type) {
    case 'email':
      return need(c.subject || c.template_id, 'email needs a subject or a template')
    case 'whatsapp':
      return need(c.template_id || c.whatsapp_template_id, 'WhatsApp needs a template')
    case 'sms':
      return need(typeof c.body === 'string' && c.body.trim(), 'SMS needs a body')
    case 'wait':
      return need((c.days || c.hours || c.minutes), 'wait needs a non-zero delay')
    case 'apply_tag':
      return need(c.tag && String(c.tag).trim(), 'apply_tag needs a tag')
    case 'update_field':
      return need(c.field && String(c.field).trim(), 'update_field needs a field')
    case 'internal_task':
      return need(c.subject && String(c.subject).trim(), 'task needs a subject')
    case 'move_pipeline_stage':
      return need(c.stage_slug && String(c.stage_slug).trim(), 'move_pipeline_stage needs a stage_slug')
    case 'webhook':
      return need(typeof c.url === 'string' && /^https:\/\//.test(c.url), 'webhook needs an https url')
    case 'branch':
      return need(c.predicate && c.predicate.type, 'branch needs a predicate')
    case 'glofox_provision':
      return null // no required config — uses the location's trial settings
    default:
      return null
  }
}

export function validateGraph(graph) {
  const shape = parseGraphShape(graph)
  if (!shape.ok) {
    return { ok: false, errors: [{ code: 'shape', message: shape.error.message }] }
  }
  const g = shape.data
  const errors = []
  const push = (code, message, nodeId) => errors.push(nodeId ? { code, nodeId, message } : { code, message })

  // unique ids
  const ids = new Set()
  for (const n of g.nodes) {
    if (ids.has(n.id)) push('duplicate_node_id', `duplicate node id "${n.id}"`, n.id)
    ids.add(n.id)
  }
  const known = new Set([TRIGGER_SOURCE_ID, ...g.nodes.map(n => n.id)])

  // edges reference known nodes
  for (const e of g.edges) {
    if (!known.has(e.from)) push('edge_unknown_source', `edge from unknown node "${e.from}"`)
    if (!known.has(e.to)) push('edge_unknown_target', `edge to unknown node "${e.to}"`)
  }

  // out-edge cardinality + branch lanes
  const outByNode = new Map()
  for (const e of g.edges) {
    if (!outByNode.has(e.from)) outByNode.set(e.from, [])
    outByNode.get(e.from).push(e)
  }
  for (const n of g.nodes) {
    const outs = outByNode.get(n.id) || []
    if (n.type === 'branch') {
      const labels = new Set(outs.map(o => o.label))
      if (outs.length !== 2 || !labels.has('yes') || !labels.has('no')) {
        push('branch_missing_lane', 'branch needs exactly one yes and one no out-edge', n.id)
      }
    } else if (outs.length > 1) {
      push('too_many_out_edges', `${n.type} node has more than one out-edge`, n.id)
    }
    const cfgErr = requiredConfigError(n)
    if (cfgErr) push('missing_config', cfgErr, n.id)
  }

  // reachability from trigger (BFS over edges)
  const adj = new Map()
  for (const e of g.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from).push(e.to)
  }
  const seen = new Set([TRIGGER_SOURCE_ID])
  const queue = [TRIGGER_SOURCE_ID]
  while (queue.length) {
    const cur = queue.shift()
    for (const to of (adj.get(cur) || [])) {
      if (!seen.has(to)) { seen.add(to); queue.push(to) }
    }
  }
  for (const n of g.nodes) {
    if (!seen.has(n.id)) push('orphan_node', `node "${n.id}" is unreachable from the trigger`, n.id)
  }

  // cycle detection (DFS colouring) over the node graph
  const WHITE = 0, GREY = 1, BLACK = 2
  const colour = new Map(g.nodes.map(n => [n.id, WHITE]))
  let cyclic = false
  const dfs = (id) => {
    colour.set(id, GREY)
    for (const to of (adj.get(id) || [])) {
      if (to === TRIGGER_SOURCE_ID) continue
      if (colour.get(to) === GREY) { cyclic = true; return }
      if (colour.get(to) === WHITE) dfs(to)
    }
    colour.set(id, BLACK)
  }
  for (const n of g.nodes) if (colour.get(n.id) === WHITE) dfs(n.id)
  if (cyclic) push('cycle', 'the flow contains a loop — steps must always move forward')

  return { ok: errors.length === 0, errors }
}
