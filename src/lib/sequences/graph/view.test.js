import { describe, it, expect } from 'vitest'
import { buildFlowLayout, describeNode, describeTrigger } from './view.js'

const graph = (nodes, edges, trigger = { type: 'manual', config: {} }) => ({
  version: 1, trigger, nodes, edges,
})

describe('buildFlowLayout — folds the graph into a render tree', () => {
  it('lays out a linear chain in order', () => {
    const g = graph(
      [{ id: 'n1', type: 'sms', config: { body: 'hi' } }, { id: 'n2', type: 'wait', config: { days: 1 } }],
      [{ from: 'trigger', to: 'n1' }, { from: 'n1', to: 'n2' }],
    )
    const l = buildFlowLayout(g)
    expect(l.kind).toBe('node')
    expect(l.node.id).toBe('n1')
    expect(l.next.kind).toBe('node')
    expect(l.next.node.id).toBe('n2')
    expect(l.next.next.kind).toBe('end')
  })

  it('forks a branch into yes/no lanes', () => {
    const g = graph(
      [
        { id: 'b', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'vip' } } },
        { id: 'y', type: 'sms', config: { body: 'yes' } },
        { id: 'n', type: 'sms', config: { body: 'no' } },
      ],
      [
        { from: 'trigger', to: 'b' },
        { from: 'b', to: 'y', label: 'yes' },
        { from: 'b', to: 'n', label: 'no' },
      ],
    )
    const l = buildFlowLayout(g)
    expect(l.kind).toBe('branch')
    expect(l.yes.node.id).toBe('y')
    expect(l.no.node.id).toBe('n')
  })

  it('renders a re-convergence (diamond) once, with the second lane pointing back', () => {
    // yes → m → end ; no → m (already rendered) → ref
    const g = graph(
      [
        { id: 'b', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'x' } } },
        { id: 'm', type: 'sms', config: { body: 'merge' } },
      ],
      [
        { from: 'trigger', to: 'b' },
        { from: 'b', to: 'm', label: 'yes' },
        { from: 'b', to: 'm', label: 'no' },
      ],
    )
    const l = buildFlowLayout(g)
    const kinds = [l.yes.kind, l.no.kind].sort()
    expect(kinds).toEqual(['node', 'ref']) // one renders m, the other refs it
    const ref = l.yes.kind === 'ref' ? l.yes : l.no
    expect(ref.nodeId).toBe('m')
  })

  it('returns end for an empty graph (trigger only)', () => {
    expect(buildFlowLayout(graph([], [])).kind).toBe('end')
  })

  it('treats a dangling edge target as the end of a lane', () => {
    const g = graph([{ id: 'n1', type: 'sms', config: { body: 'hi' } }], [{ from: 'trigger', to: 'n1' }, { from: 'n1', to: 'ghost' }])
    expect(buildFlowLayout(g).next.kind).toBe('end')
  })
})

describe('describeNode — operator-facing one-line summary per type', () => {
  const cases = [
    [{ type: 'email', config: { subject: 'Welcome!' } }, 'Email', 'Welcome!'],
    [{ type: 'sms', config: { body: 'Hi there friend' } }, 'SMS', 'Hi there friend'],
    [{ type: 'wait', config: { days: 2, hours: 3 } }, 'Wait', 'Wait 2 days 3 hours'],
    [{ type: 'wait', config: { minutes: 30 } }, 'Wait', 'Wait 30 minutes'],
    [{ type: 'apply_tag', config: { tag: 'vip' } }, 'Apply tag', 'Add tag “vip”'],
    [{ type: 'update_field', config: { field: 'label', value: 'hot' } }, 'Update field', 'Set label = hot'],
    [{ type: 'internal_task', config: { subject: 'Call them' } }, 'Internal task', 'Call them'],
    [{ type: 'webhook', config: { url: 'https://x.io/hook', method: 'POST' } }, 'Webhook', 'POST https://x.io/hook'],
    [{ type: 'move_pipeline_stage', config: { stage_slug: 'active_member' } }, 'Move pipeline', 'Move to active_member'],
    [{ type: 'branch', config: { predicate: { type: 'has_tag', tag: 'vip' } } }, 'Branch', 'Has tag “vip”'],
    [{ type: 'branch', config: { predicate: { type: 'field_equals', field: 'label', value: 'hot' } } }, 'Branch', 'label = hot'],
    [{ type: 'glofox_provision', config: {} }, 'Create in Glofox', 'Create Glofox account + trial'],
  ]
  for (const [node, typeLabel, summary] of cases) {
    it(`${node.type} → ${typeLabel} / ${summary}`, () => {
      expect(describeNode(node)).toEqual({ typeLabel, summary })
    })
  }

  it('falls back gracefully when config is sparse', () => {
    expect(describeNode({ type: 'email', config: {} }).summary).toBe('Email')
    expect(describeNode({ type: 'sms', config: {} }).summary).toBe('SMS message')
  })
})

describe('describeTrigger — what starts the flow', () => {
  it('maps known trigger types to friendly labels', () => {
    expect(describeTrigger({ type: 'manual' })).toBe('Manually enrolled')
    expect(describeTrigger({ type: 'booking_created' })).toBe('When a booking is created')
    expect(describeTrigger({ type: 'tag_added', config: { tag: 'trial' } })).toBe('When the tag “trial” is added')
  })
  it('humanises an unknown trigger type', () => {
    expect(describeTrigger({ type: 'some_new_thing' })).toBe('Some new thing')
  })
})
