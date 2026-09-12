import { describe, it, expect } from 'vitest'
import { validateGraph } from './validate.js'

const base = () => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'n1', type: 'sms', config: { body: 'hi' } },
  ],
  edges: [{ from: 'trigger', to: 'n1' }],
})
const codes = (g) => validateGraph(g).errors.map(e => e.code)

describe('validateGraph', () => {
  it('accepts a minimal valid graph', () => {
    expect(validateGraph(base())).toEqual({ ok: true, errors: [] })
  })

  it('rejects a structurally invalid graph (shape)', () => {
    const r = validateGraph({ nodes: [] })
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('shape')
  })

  it('flags an edge to a non-existent node', () => {
    const g = base(); g.edges.push({ from: 'n1', to: 'ghost' })
    expect(codes(g)).toContain('edge_unknown_target')
  })

  it('flags a duplicate node id', () => {
    const g = base(); g.nodes.push({ id: 'n1', type: 'wait', config: { days: 1 } })
    expect(codes(g)).toContain('duplicate_node_id')
  })

  it('flags an orphan (unreachable from trigger)', () => {
    const g = base(); g.nodes.push({ id: 'n2', type: 'sms', config: { body: 'x' } })
    expect(codes(g)).toContain('orphan_node')
  })

  it('flags a non-branch node with two out-edges', () => {
    const g = base()
    g.nodes.push({ id: 'n2', type: 'sms', config: { body: 'a' } })
    g.nodes.push({ id: 'n3', type: 'sms', config: { body: 'b' } })
    g.edges.push({ from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' })
    expect(codes(g)).toContain('too_many_out_edges')
  })

  it('flags a branch missing the no lane', () => {
    const g = base()
    g.nodes[0] = { id: 'n1', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'vip' } } }
    g.nodes.push({ id: 'n2', type: 'sms', config: { body: 'yes' } })
    g.edges.push({ from: 'n1', to: 'n2', label: 'yes' })
    expect(codes(g)).toContain('branch_missing_lane')
  })

  it('flags a cycle (loop guard)', () => {
    const g = base()
    g.nodes.push({ id: 'n2', type: 'wait', config: { days: 1 } })
    g.edges.push({ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' })
    expect(codes(g)).toContain('cycle')
  })

  it('flags missing required config per type', () => {
    expect(codes({ ...base(), nodes: [{ id: 'n1', type: 'apply_tag', config: {} }] }))
      .toContain('missing_config')
    expect(codes({ ...base(), nodes: [{ id: 'n1', type: 'sms', config: {} }] }))
      .toContain('missing_config')
    expect(codes({ ...base(), nodes: [{ id: 'n1', type: 'webhook', config: { url: 'http://x' } }] }))
      .toContain('missing_config') // non-https rejected
  })

  it('attaches the offending nodeId to node-scoped errors', () => {
    const g = base(); g.nodes[0].config = {}
    const err = validateGraph(g).errors.find(e => e.code === 'missing_config')
    expect(err.nodeId).toBe('n1')
  })

  it('accepts a glofox_provision node with no config', () => {
    const g = {
      version: 1,
      trigger: { type: 'manual', config: {} },
      nodes: [{ id: 'n1', type: 'glofox_provision', config: {} }],
      edges: [{ from: 'trigger', to: 'n1' }],
    }
    const r = validateGraph(g)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  // Trigger-taxonomy reconciliation (PR3c-4): the runner fires these, so the
  // graph schema must accept them. Previously schema.js had 'order_status' /
  // 'achievement' (never the runner's names) and the builder couldn't load such
  // sequences without a shape error.
  it('accepts every trigger type the runner actually fires', () => {
    for (const type of ['pipeline_stage_change', 'segment_added', 'segment_removed', 'order_completed', 'order_failed', 'order_abandoned', 'achievement_unlocked', 'first_booking']) {
      const g = { ...base(), trigger: { type, config: {} } }
      expect(validateGraph(g)).toEqual({ ok: true, errors: [] })
    }
  })
})

// SEQ-URLBUTTON.1 — the publish gate for a dynamic URL button's per-send value.
//
// Without the value Meta rejects EVERY message with 132012, so a step that maps
// nothing can only ever fail — one contact at a time, weeks after the operator
// published it and stopped looking. The check needs the TEMPLATE (the graph
// stores only an id), so validateGraph takes the location's rows as an option
// and stays pure. Unknown template id → no opinion: the builder loads templates
// asynchronously and must not red-flag a step while the list is still empty.
describe('validateGraph — dynamic URL button value (SEQ-URLBUTTON.1)', () => {
  const DYNAMIC = {
    id: 'wt-dyn',
    name: 'Overdue pay link',
    components: [
      { type: 'BODY', text: 'Hi {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.repset.ie/{{1}}', example: ['x'] }] },
    ],
  }
  const STATIC = {
    id: 'wt-fixed',
    name: 'Welcome',
    components: [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Book', url: 'https://repset.ie/book' }] }],
  }
  const waGraph = (config) => ({
    version: 1,
    trigger: { type: 'manual', config: {} },
    nodes: [{ id: 'n1', type: 'whatsapp', config }],
    edges: [{ from: 'trigger', to: 'n1' }],
  })

  it('flags a dynamic-URL template with no url_button value', () => {
    const r = validateGraph(waGraph({ template_id: 'wt-dyn', variables: { 1: 'first_name' } }), { whatsappTemplates: [DYNAMIC] })
    expect(r.ok).toBe(false)
    const issue = r.errors.find(e => e.code === 'url_button_value_missing')
    expect(issue).toBeTruthy()
    expect(issue.nodeId).toBe('n1')
    expect(issue.message).toContain('Pay now')
    expect(issue.message).toContain('on this step before publishing')
  })

  it('names the step so the operator can find it in a long flow', () => {
    const g = waGraph({ template_id: 'wt-dyn', variables: {} })
    g.nodes.unshift({ id: 'n0', type: 'sms', config: { body: 'hi' } })
    g.edges = [{ from: 'trigger', to: 'n0' }, { from: 'n0', to: 'n1' }]
    const issue = validateGraph(g, { whatsappTemplates: [DYNAMIC] }).errors.find(e => e.code === 'url_button_value_missing')
    expect(issue.message).toMatch(/step 2/i)
  })

  it('passes once url_button is mapped', () => {
    const r = validateGraph(waGraph({ template_id: 'wt-dyn', variables: { url_button: 'pay_link_suffix' } }), { whatsappTemplates: [DYNAMIC] })
    expect(r.ok).toBe(true)
  })

  it('treats a whitespace-only value as missing', () => {
    const codes2 = validateGraph(waGraph({ template_id: 'wt-dyn', variables: { url_button: '   ' } }), { whatsappTemplates: [DYNAMIC] }).errors.map(e => e.code)
    expect(codes2).toContain('url_button_value_missing')
  })

  it('says nothing about a template whose link carries no variable', () => {
    expect(validateGraph(waGraph({ template_id: 'wt-fixed', variables: {} }), { whatsappTemplates: [STATIC] }).ok).toBe(true)
  })

  it('says nothing when the template list is absent or does not contain the id', () => {
    const g = waGraph({ template_id: 'wt-dyn', variables: {} })
    expect(validateGraph(g).ok).toBe(true)
    expect(validateGraph(g, { whatsappTemplates: [] }).ok).toBe(true)
    expect(validateGraph(g, { whatsappTemplates: [STATIC] }).ok).toBe(true)
  })

  it('reads the legacy whatsapp_template_id / whatsapp_variables spelling too', () => {
    const g = waGraph({ whatsapp_template_id: 'wt-dyn', whatsapp_variables: {} })
    expect(validateGraph(g, { whatsappTemplates: [DYNAMIC] }).ok).toBe(false)
  })
})
