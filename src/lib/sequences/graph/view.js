// FLOW-GRAPH Phase 2 — pure view helpers for the guided-rail builder. Folds the
// declarative graph into a render tree (branches → yes/no lanes) and renders
// each node/trigger as a one-line operator-facing summary. Pure + tested so the
// vocabulary operators read is pinned; icons/colours stay in the component.
import { TRIGGER_SOURCE_ID } from './schema.js'

// ---- layout -------------------------------------------------------------

/**
 * Fold a graph into a render tree starting at the trigger's first target.
 * Shapes: {kind:'node', node, next} | {kind:'branch', node, yes, no}
 *         | {kind:'ref', nodeId} (re-convergence pointer) | {kind:'end'}.
 * The graph is a DAG (validate forbids cycles); a node already emitted in
 * another lane becomes a 'ref' so a diamond renders once.
 */
export function buildFlowLayout(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return { kind: 'end' }
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const edges = Array.isArray(graph.edges) ? graph.edges : []
  const outs = (id) => edges.filter(e => e.from === id)
  const firstTo = (id) => { const e = outs(id)[0]; return e ? e.to : null }
  const laneTo = (id, label) => { const e = outs(id).find(x => x.label === label); return e ? e.to : null }
  const visited = new Set()

  function walk(nodeId) {
    if (nodeId == null || !byId.has(nodeId)) return { kind: 'end' }
    if (visited.has(nodeId)) return { kind: 'ref', nodeId }
    visited.add(nodeId)
    const node = byId.get(nodeId)
    if (node.type === 'branch') {
      return { kind: 'branch', node, yes: walk(laneTo(nodeId, 'yes')), no: walk(laneTo(nodeId, 'no')) }
    }
    return { kind: 'node', node, next: walk(firstTo(nodeId)) }
  }
  return walk(firstTo(TRIGGER_SOURCE_ID))
}

// ---- per-node summary ---------------------------------------------------

const TYPE_LABELS = {
  email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS', wait: 'Wait',
  apply_tag: 'Apply tag', update_field: 'Update field', internal_task: 'Internal task',
  webhook: 'Webhook', branch: 'Branch', move_pipeline_stage: 'Move pipeline',
  glofox_provision: 'Create in Glofox',
}

function humaniseDelay(c) {
  const parts = []
  if (c.days) parts.push(`${c.days} day${c.days === 1 ? '' : 's'}`)
  if (c.hours) parts.push(`${c.hours} hour${c.hours === 1 ? '' : 's'}`)
  if (c.minutes) parts.push(`${c.minutes} minute${c.minutes === 1 ? '' : 's'}`)
  return parts.length ? `Wait ${parts.join(' ')}` : 'No delay'
}

function describePredicate(p) {
  if (!p || !p.type) return 'Condition'
  switch (p.type) {
    case 'has_tag': return `Has tag “${p.tag ?? ''}”`
    case 'field_equals': return `${p.field ?? 'field'} = ${p.value ?? ''}`
    case 'field_in': return `${p.field ?? 'field'} in [${(p.values || []).join(', ')}]`
    default: return humanise(p.type)
  }
}

/** A node → { typeLabel, summary } for the builder card. Pure. */
export function describeNode(node) {
  const c = node?.config || {}
  const typeLabel = TYPE_LABELS[node?.type] || humanise(node?.type || 'step')
  let summary
  switch (node?.type) {
    case 'email': summary = c.subject || 'Email'; break
    case 'whatsapp': summary = c.template_id || c.whatsapp_template_id ? 'WhatsApp template' : 'WhatsApp message'; break
    case 'sms': summary = (c.body && String(c.body).trim()) || 'SMS message'; break
    case 'wait': summary = humaniseDelay(c); break
    case 'apply_tag': summary = c.tag ? `Add tag “${c.tag}”` : 'Apply tag'; break
    case 'update_field': summary = c.field ? `Set ${c.field}${c.value != null && c.value !== '' ? ` = ${c.value}` : ''}` : 'Update field'; break
    case 'internal_task': summary = c.subject || 'Create task'; break
    case 'webhook': summary = c.url ? `${c.method || 'POST'} ${c.url}` : 'Webhook'; break
    case 'move_pipeline_stage': summary = c.stage_slug ? `Move to ${c.stage_slug}` : 'Move pipeline stage'; break
    case 'branch': summary = describePredicate(c.predicate); break
    case 'glofox_provision': summary = 'Create Glofox account + trial'; break
    default: summary = typeLabel
  }
  return { typeLabel, summary }
}

// ---- trigger summary ----------------------------------------------------

const TRIGGER_LABELS = {
  manual: () => 'Manually enrolled',
  contact_created: () => 'When a new lead is created',
  booking_created: () => 'When a booking is created',
  pipeline_stage_change: (c) => c?.to_stage ? `When pipeline stage becomes ${c.to_stage}` : 'When pipeline stage changes',
  tag_added: (c) => c?.tag ? `When the tag “${c.tag}” is added` : 'When a tag is added',
  event_reminder: () => 'Before a booking (reminder)',
  segment_entered: () => 'When a contact enters a segment',
  segment_exited: () => 'When a contact leaves a segment',
  anniversary: () => 'On an anniversary date',
  inactivity: () => 'After a period of inactivity',
  inbound_webhook: () => 'When an inbound webhook fires',
  webhook: () => 'When an inbound webhook fires',
}

/** Trigger → friendly sentence. Pure. */
export function describeTrigger(trigger) {
  const fn = TRIGGER_LABELS[trigger?.type]
  return fn ? fn(trigger?.config || {}) : humanise(trigger?.type || 'manual')
}

// "some_new_thing" → "Some new thing"
function humanise(s) {
  const t = String(s).replace(/_/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''
}
