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

// SEQ-TERMINAL — steps compiled from a graph carry config.next_step_order
// (integer successor or 'end'). Decompile must honour the marker when
// rebuilding edges — NOT assume linear fall-through — and strip it from
// node config (it is derived from edges, not authored).
describe('decompileStepsToGraph — next_step_order markers', () => {
  it("emits no out-edge for a step marked 'end', even when later steps exist", () => {
    const steps = [
      { step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' }, then_step_order: 2, else_step_order: 3 } },
      { step_order: 2, step_type: 'apply_tag', config: { tag: 'done', next_step_order: 'end' } },
      { step_order: 3, step_type: 'sms', sms_body: 'no arm', config: { next_step_order: 'end' } },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges.filter(e => e.from === 'n2')).toEqual([])
    expect(g.edges.filter(e => e.from === 'n3')).toEqual([])
  })

  it('wires the out-edge to the marked successor, not to the next row (convergence)', () => {
    const steps = [
      { step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' }, then_step_order: 2, else_step_order: 3 } },
      { step_order: 2, step_type: 'apply_tag', config: { tag: 'went', next_step_order: 4 } },
      { step_order: 3, step_type: 'sms', sms_body: 'come back', config: { next_step_order: 4 } },
      { step_order: 4, step_type: 'email', subject: 'weekly', template_id: 't1', config: { next_step_order: 'end' } },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toContainEqual({ from: 'n2', to: 'n4' })
    expect(g.edges).toContainEqual({ from: 'n3', to: 'n4' })
    expect(g.edges.filter(e => e.from === 'n2' && e.to === 'n3')).toEqual([])
  })

  it('strips next_step_order from data-node config (it is edge information)', () => {
    const steps = [{ step_order: 1, step_type: 'apply_tag', config: { tag: 'vip', next_step_order: 'end' } }]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.nodes[0].config).toEqual({ tag: 'vip' })
  })

  it('legacy steps without markers keep the linear fall-through wiring', () => {
    const steps = [
      { step_order: 1, step_type: 'wait', delay_days: 0, delay_hours: 1, delay_minutes: 0 },
      { step_order: 2, step_type: 'sms', sms_body: 'hi' },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toContainEqual({ from: 'n1', to: 'n2' })
  })
})

// FLOW-DELAY.1 — the builder used to keep a delay ONLY on a `wait` step.
// Every other step type carries the same three delay columns and the runner
// honours them (nextStepDelayMs is applied to whatever row it advances into,
// regardless of step_type), and 19 of the 25 gallery templates rely on that.
// Decompiling dropped them, so the very next Publish rewrote a 7-day drip
// into a burst of sends inside the hour.
//
// The fix keeps the graph vocabulary as it is — a delay lives on a `wait`
// node, full stop — and lifts an action step's delay into a SYNTHETIC wait
// node placed immediately before it (`w<step_order>`). Everything that
// pointed AT the action must now point at that wait, or the delay is
// jumped over.
describe('decompileStepsToGraph — delays on non-wait steps (FLOW-DELAY.1)', () => {
  it('lifts an action step delay into a synthetic wait node before it', () => {
    const steps = [
      { step_order: 1, step_type: 'email', subject: 'day 0', template_id: null },
      { step_order: 2, step_type: 'email', subject: 'day 3', delay_days: 3, delay_hours: 0, delay_minutes: 0 },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.nodes.map(n => [n.id, n.type])).toEqual([['n1', 'email'], ['w2', 'wait'], ['n2', 'email']])
    expect(g.nodes[1].config).toEqual({ days: 3, hours: 0, minutes: 0 })
    // the action itself carries no delay — it is the wait's job now
    expect(g.nodes[2].config).toEqual({ subject: 'day 3', html_content: null, template_id: null })
    expect(g.edges).toEqual([
      { from: 'trigger', to: 'n1' },
      { from: 'n1', to: 'w2' },
      { from: 'w2', to: 'n2' },
    ])
  })

  it('emits no synthetic wait for a zero-delay action step', () => {
    const steps = [
      { step_order: 1, step_type: 'sms', sms_body: 'hi', delay_days: 0, delay_hours: 0, delay_minutes: 0 },
      { step_order: 2, step_type: 'sms', sms_body: 'again' },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.nodes.map(n => n.id)).toEqual(['n1', 'n2'])
  })

  it('leaves a real wait step exactly as it was (no double node)', () => {
    const steps = [
      { step_order: 1, step_type: 'wait', delay_days: 0, delay_hours: 1, delay_minutes: 0 },
      { step_order: 2, step_type: 'sms', sms_body: 'hi' },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.nodes.map(n => [n.id, n.type])).toEqual([['n1', 'wait'], ['n2', 'sms']])
  })

  it('re-targets the trigger edge when the FIRST step carries a delay', () => {
    const steps = [
      { step_order: 1, step_type: 'sms', sms_body: 'hi', delay_hours: 1 },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toEqual([
      { from: 'trigger', to: 'w1' },
      { from: 'w1', to: 'n1' },
    ])
  })

  it('points branch yes/no lanes at the synthetic wait, not past it', () => {
    const steps = [
      { step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' }, then_step_order: 2, else_step_order: 3 } },
      { step_order: 2, step_type: 'email', subject: 'yes', delay_days: 2 },
      { step_order: 3, step_type: 'sms', sms_body: 'no', delay_hours: 6 },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toContainEqual({ from: 'n1', to: 'w2', label: 'yes' })
    expect(g.edges).toContainEqual({ from: 'n1', to: 'w3', label: 'no' })
    expect(g.edges).toContainEqual({ from: 'w2', to: 'n2' })
    expect(g.edges).toContainEqual({ from: 'w3', to: 'n3' })
    expect(g.edges.filter(e => e.from === 'n1' && (e.to === 'n2' || e.to === 'n3'))).toEqual([])
  })

  it('points a next_step_order jump at the synthetic wait, not past it', () => {
    const steps = [
      { step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' }, then_step_order: 2, else_step_order: 3 } },
      { step_order: 2, step_type: 'apply_tag', config: { tag: 'went', next_step_order: 4 } },
      { step_order: 3, step_type: 'sms', sms_body: 'come back', config: { next_step_order: 4 } },
      { step_order: 4, step_type: 'email', subject: 'weekly', delay_days: 1, config: { next_step_order: 'end' } },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.edges).toContainEqual({ from: 'n2', to: 'w4' })
    expect(g.edges).toContainEqual({ from: 'n3', to: 'w4' })
    expect(g.edges).toContainEqual({ from: 'w4', to: 'n4' })
    expect(g.edges.filter(e => e.to === 'n4' && e.from !== 'w4')).toEqual([])
  })

  it('lifts a delay off a non-channel step too (the runner honours those rows as well)', () => {
    const steps = [
      { step_order: 1, step_type: 'email', subject: 'hi' },
      { step_order: 2, step_type: 'apply_tag', delay_days: 5, config: { tag: 'cold' } },
    ]
    const g = decompileStepsToGraph(steps, trigger)
    expect(g.nodes.map(n => [n.id, n.type])).toEqual([['n1', 'email'], ['w2', 'wait'], ['n2', 'apply_tag']])
    expect(g.nodes[1].config).toEqual({ days: 5, hours: 0, minutes: 0 })
    expect(g.nodes[2].config).toEqual({ tag: 'cold' })
  })
})
