// FLOW-GRAPH.3 — compile a flow graph into sequence_steps rows that the
// existing runner executes unchanged. Pure. Channel nodes map to dedicated
// columns; data/logic nodes map to the config jsonb; branch out-edges map
// to config.then_step_order / config.else_step_order. Deterministic BFS,
// enqueueing a branch's `yes` target before its `no` target.
import { isChannelNode, TRIGGER_SOURCE_ID } from './schema.js'

function outEdges(edges, from) {
  return edges.filter(e => e.from === from)
}

// BFS order from trigger → array of node ids, stable.
function orderNodes(graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const order = []
  const seen = new Set()
  const queue = [...outEdges(graph.edges, TRIGGER_SOURCE_ID).map(e => e.to)]
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id) || !byId.has(id)) continue
    seen.add(id)
    order.push(id)
    const node = byId.get(id)
    const outs = outEdges(graph.edges, id)
    if (node.type === 'branch') {
      const yes = outs.find(o => o.label === 'yes')
      const no = outs.find(o => o.label === 'no')
      if (yes) queue.push(yes.to)
      if (no) queue.push(no.to)
    } else {
      for (const o of outs) queue.push(o.to)
    }
  }
  return order
}

function channelColumns(node) {
  const c = node.config || {}
  switch (node.type) {
    case 'email':
      return { subject: c.subject ?? null, html_content: c.html_content ?? null, template_id: c.template_id ?? null }
    case 'whatsapp':
      return {
        whatsapp_template_id: c.template_id ?? c.whatsapp_template_id ?? null,
        whatsapp_variables: c.variables ?? c.whatsapp_variables ?? {},
        whatsapp_header_media_url: c.header_media_url ?? null,
      }
    case 'sms':
      return { sms_body: c.body ?? null }
    case 'wait':
      return { delay_days: c.days ?? 0, delay_hours: c.hours ?? 0, delay_minutes: c.minutes ?? 0 }
    default:
      return {}
  }
}

export function compileGraphToSteps(graph) {
  const order = orderNodes(graph)
  const stepOrderById = new Map(order.map((id, i) => [id, i + 1]))
  const byId = new Map(graph.nodes.map(n => [n.id, n]))

  return order.map((id) => {
    const node = byId.get(id)
    const row = {
      step_order: stepOrderById.get(id),
      step_type: node.type,
      delay_days: 0, delay_hours: 0, delay_minutes: 0,
    }
    if (isChannelNode(node.type)) {
      Object.assign(row, channelColumns(node))
    } else if (node.type === 'branch') {
      const outs = outEdges(graph.edges, id)
      const yes = outs.find(o => o.label === 'yes')
      const no = outs.find(o => o.label === 'no')
      row.config = {
        ...(node.config || {}),
        then_step_order: yes ? stepOrderById.get(yes.to) : null,
        else_step_order: no ? stepOrderById.get(no.to) : null,
      }
    } else {
      row.config = { ...(node.config || {}) }
    }
    return row
  })
}
