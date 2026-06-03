import { describe, it, expect } from 'vitest'
import { graphToTree, treeToGraph, isPureTree, flattenTreeIds } from './tree.js'
import { validateGraph } from './validate.js'

const g = (nodes, edges, trigger = { type: 'manual', config: {} }) => ({ version: 1, trigger, nodes, edges })

const linear = g(
  [{ id: 'n1', type: 'sms', config: { body: 'a' } }, { id: 'n2', type: 'wait', config: { days: 1 } }],
  [{ from: 'trigger', to: 'n1' }, { from: 'n1', to: 'n2' }],
)

// trigger → n1(sms) → b(branch); yes → y1(sms); no → x1(sms)
const branchy = g(
  [
    { id: 'n1', type: 'sms', config: { body: 'hi' } },
    { id: 'b', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'vip' } } },
    { id: 'y1', type: 'sms', config: { body: 'yes path' } },
    { id: 'x1', type: 'sms', config: { body: 'no path' } },
  ],
  [
    { from: 'trigger', to: 'n1' },
    { from: 'n1', to: 'b' },
    { from: 'b', to: 'y1', label: 'yes' },
    { from: 'b', to: 'x1', label: 'no' },
  ],
)

// diamond: both lanes converge on m → NOT a pure tree
const reconvergent = g(
  [
    { id: 'b', type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' } } },
    { id: 'm', type: 'sms', config: { body: 'merge' } },
  ],
  [
    { from: 'trigger', to: 'b' },
    { from: 'b', to: 'm', label: 'yes' },
    { from: 'b', to: 'm', label: 'no' },
  ],
)

describe('graphToTree', () => {
  it('turns a linear graph into a single flat lane', () => {
    const r = graphToTree(linear)
    expect(r.ok).toBe(true)
    expect(r.tree.map(i => i.id)).toEqual(['n1', 'n2'])
  })

  it('nests a branch into yes/no sub-lanes', () => {
    const r = graphToTree(branchy)
    expect(r.ok).toBe(true)
    expect(r.tree.map(i => i.id)).toEqual(['n1', 'b'])
    const branch = r.tree[1]
    expect(branch.type).toBe('branch')
    expect(branch.yes.map(i => i.id)).toEqual(['y1'])
    expect(branch.no.map(i => i.id)).toEqual(['x1'])
  })

  it('rejects a re-convergent (diamond) graph', () => {
    expect(graphToTree(reconvergent).ok).toBe(false)
  })
})

describe('treeToGraph round-trips', () => {
  for (const [name, graph] of [['linear', linear], ['branchy', branchy]]) {
    it(`${name}: treeToGraph(graphToTree) reproduces nodes + edges`, () => {
      const { tree } = graphToTree(graph)
      const back = treeToGraph(graph.trigger, tree)
      expect(back.nodes.map(n => n.id).sort()).toEqual(graph.nodes.map(n => n.id).sort())
      expect(back.edges).toEqual(expect.arrayContaining(graph.edges))
      expect(back.edges).toHaveLength(graph.edges.length)
      // and it's still a valid graph
      expect(validateGraph(back).ok).toBe(true)
    })
  }

  it('omits the edge for an empty branch lane (validation then flags it)', () => {
    const tree = [{ id: 'b', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'x' } }, yes: [{ id: 'y', type: 'sms', config: { body: 'y' } }], no: [] }]
    const back = treeToGraph({ type: 'manual', config: {} }, tree)
    expect(back.edges.find(e => e.label === 'no')).toBeUndefined()
    expect(validateGraph(back).errors.map(e => e.code)).toContain('branch_missing_lane')
  })
})

describe('isPureTree', () => {
  it('is true for linear + branchy, false for re-convergent', () => {
    expect(isPureTree(linear)).toBe(true)
    expect(isPureTree(branchy)).toBe(true)
    expect(isPureTree(reconvergent)).toBe(false)
  })
  it('is false when an orphan node sits off the tree', () => {
    const orphaned = g(
      [...linear.nodes, { id: 'z', type: 'sms', config: { body: 'z' } }],
      linear.edges,
    )
    expect(isPureTree(orphaned)).toBe(false)
  })
})

describe('flattenTreeIds', () => {
  it('collects every id including nested lanes', () => {
    const { tree } = graphToTree(branchy)
    expect(flattenTreeIds(tree).sort()).toEqual(['b', 'n1', 'x1', 'y1'])
  })
})
