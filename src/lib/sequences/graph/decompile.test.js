import { describe, it, expect } from 'vitest'
import { decompileStepsToGraph } from './decompile.js'

const trigger = { type: 'booking_created', config: { event_type_id: 'e1' } }

describe('decompileStepsToGraph', () => {
  it('builds a linear graph with sequential edges', () => {
    const steps = [
      { step_order: 1, step_type: 'wait', delay_days: 0, delay_hours: 1, delay_minutes: 0 },
      { step_order: 2, step_type: 'sms', sms_body: 'hi' },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.trigger).toEqual(trigger)
    expect(g.nodes.map(n => [n.id, n.type])).toEqual([['n1', 'wait'], ['n2', 'sms']])
    expect(g.edges).toEqual([
      { from: 'trigger', to: 'n1' },
      { from: 'n1', to: 'n2' },
    ])
    expect(g.nodes[0].config).toEqual({ days: 0, hours: 1, minutes: 0 })
    expect(g.nodes[1].config).toEqual({ body: 'hi' })
  })

  it('rebuilds branch lanes from then/else pointers', () => {
    const steps = [
      { step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' }, then_step_order: 2, else_step_order: 3 } },
      { step_order: 2, step_type: 'email', subject: 'yes', template_id: 'x' },
      { step_order: 3, step_type: 'sms', sms_body: 'no' },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toContainEqual({ from: 'trigger', to: 'n1' })
    expect(g.edges).toContainEqual({ from: 'n1', to: 'n2', label: 'yes' })
    expect(g.edges).toContainEqual({ from: 'n1', to: 'n3', label: 'no' })
    // a branch never falls through to k+1
    expect(g.edges.filter(e => e.from === 'n1' && !e.label)).toEqual([])
    // pointers are dropped from node config (they are edges now)
    expect(g.nodes[0].config).toEqual({ predicate: { type: 'has_tag', tag: 't' } })
  })

  it('emits no out-edge for the terminal step', () => {
    const steps = [{ step_order: 1, step_type: 'sms', sms_body: 'bye' }]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toEqual([{ from: 'trigger', to: 'n1' }])
  })

  it('handles a sequence with no steps', () => {
    expect(decompileStepsToGraph([], trigger)).toEqual({ version: 1, trigger, nodes: [], edges: [] })
  })
})
