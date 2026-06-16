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
