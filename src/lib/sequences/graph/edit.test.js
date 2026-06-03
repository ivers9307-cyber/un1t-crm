import { describe, it, expect } from 'vitest'
import {
  linearOrder, isLinearGraph, toLinearGraph, rebuildLinearEdges,
  nextNodeId, defaultConfigForType,
} from './edit.js'

const linear = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'n1', type: 'sms', config: { body: 'a' } },
    { id: 'n2', type: 'wait', config: { days: 1 } },
    { id: 'n3', type: 'email', config: { subject: 'hi' } },
  ],
  edges: [
    { from: 'trigger', to: 'n1' },
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
  ],
}

const branchy = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'b', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'x' } } },
    { id: 'y', type: 'sms', config: { body: 'y' } },
    { id: 'n', type: 'sms', config: { body: 'n' } },
  ],
  edges: [
    { from: 'trigger', to: 'b' },
    { from: 'b', to: 'y', label: 'yes' },
    { from: 'b', to: 'n', label: 'no' },
  ],
}

describe('linearOrder', () => {
  it('returns nodes in flow order from the trigger', () => {
    expect(linearOrder(linear).map(n => n.id)).toEqual(['n1', 'n2', 'n3'])
  })
  it('returns [] for an empty graph', () => {
    expect(linearOrder({ trigger: { type: 'manual' }, nodes: [], edges: [] })).toEqual([])
  })
})

describe('isLinearGraph', () => {
  it('is true for a single unbroken chain', () => {
    expect(isLinearGraph(linear)).toBe(true)
  })
  it('is true for an empty graph (editable from scratch)', () => {
    expect(isLinearGraph({ trigger: { type: 'manual' }, nodes: [], edges: [] })).toBe(true)
  })
  it('is false when a branch node exists', () => {
    expect(isLinearGraph(branchy)).toBe(false)
  })
  it('is false when a node is orphaned off the chain', () => {
    const g = { ...linear, nodes: [...linear.nodes, { id: 'orphan', type: 'sms', config: { body: 'x' } }] }
    expect(isLinearGraph(g)).toBe(false)
  })
})

describe('rebuildLinearEdges', () => {
  it('chains trigger → n1 → n2 → …', () => {
    expect(rebuildLinearEdges(linear.nodes)).toEqual([
      { from: 'trigger', to: 'n1' },
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ])
  })
  it('returns [] for no nodes', () => {
    expect(rebuildLinearEdges([])).toEqual([])
  })
})

describe('toLinearGraph', () => {
  it('rebuilds a valid linear graph from an ordered node list', () => {
    const g = toLinearGraph({ type: 'manual', config: {} }, linear.nodes)
    expect(g.edges).toEqual(linear.edges)
    expect(g.nodes).toBe(linear.nodes)
    expect(g.trigger).toEqual({ type: 'manual', config: {} })
  })
  it('round-trips: toLinearGraph(linearOrder(g)) reproduces the edges', () => {
    expect(toLinearGraph(linear.trigger, linearOrder(linear)).edges).toEqual(linear.edges)
  })
  it('defaults the trigger when none is given', () => {
    expect(toLinearGraph(null, []).trigger).toEqual({ type: 'manual', config: {} })
  })
})

describe('nextNodeId', () => {
  it('is one past the highest n<N>', () => {
    expect(nextNodeId(linear.nodes)).toBe('n4')
  })
  it('is n1 for an empty list', () => {
    expect(nextNodeId([])).toBe('n1')
  })
  it('ignores ids that do not match the n<N> pattern', () => {
    expect(nextNodeId([{ id: 'weird' }, { id: 'n2' }])).toBe('n3')
  })
})

describe('defaultConfigForType', () => {
  it('seeds a wait with a 1-day delay so it passes validation', () => {
    expect(defaultConfigForType('wait')).toEqual({ days: 1, hours: 0, minutes: 0 })
  })
  it('seeds a webhook with the POST method', () => {
    expect(defaultConfigForType('webhook')).toEqual({ url: '', method: 'POST' })
  })
  it('returns an empty object for an unknown type', () => {
    expect(defaultConfigForType('mystery')).toEqual({})
  })
})
