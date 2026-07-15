import { describe, it, expect } from 'vitest'
import { compileGraphToSteps } from './compile.js'

const linear = {
  version: 1,
  trigger: { type: 'booking_created', config: {} },
  nodes: [
    { id: 'a', type: 'wait', config: { days: 0, hours: 1, minutes: 0 } },
    { id: 'b', type: 'sms', config: { body: 'hello' } },
  ],
  edges: [{ from: 'trigger', to: 'a' }, { from: 'a', to: 'b' }],
}

const branched = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [
    { id: 'br', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'attended' } } },
    { id: 'y', type: 'email', config: { subject: 'How was it?', template_id: 't1' } },
    { id: 'n', type: 'sms', config: { body: 'come back' } },
  ],
  edges: [
    { from: 'trigger', to: 'br' },
    { from: 'br', to: 'y', label: 'yes' },
    { from: 'br', to: 'n', label: 'no' },
  ],
}

describe('compileGraphToSteps', () => {
  it('assigns sequential step_order from the trigger', () => {
    const steps = compileGraphToSteps(linear)
    expect(steps.map(s => [s.step_order, s.step_type])).toEqual([[1, 'wait'], [2, 'sms']])
  })
  it('maps channel-node config to the dedicated columns', () => {
    const steps = compileGraphToSteps(linear)
    expect(steps[0]).toMatchObject({ step_type: 'wait', delay_hours: 1, delay_days: 0, delay_minutes: 0 })
    expect(steps[1]).toMatchObject({ step_type: 'sms', sms_body: 'hello' })
  })
  it('compiles a branch to then/else step_order pointers (yes before no)', () => {
    const steps = compileGraphToSteps(branched)
    const br = steps.find(s => s.step_type === 'branch')
    const yes = steps.find(s => s.step_type === 'email')
    const no = steps.find(s => s.step_type === 'sms')
    expect(br.config.then_step_order).toBe(yes.step_order)
    expect(br.config.else_step_order).toBe(no.step_order)
    expect(br.config.then_step_order).toBeGreaterThan(br.step_order) // loop guard
    expect(br.config.else_step_order).toBeGreaterThan(br.step_order)
    expect(br.config.predicate).toEqual({ type: 'has_tag', tag: 'attended' })
  })
  it('puts data-node config in the config column', () => {
    const g = { ...linear, nodes: [{ id: 'a', type: 'apply_tag', config: { tag: 'vip' } }], edges: [{ from: 'trigger', to: 'a' }] }
    expect(compileGraphToSteps(g)[0]).toMatchObject({ step_type: 'apply_tag', config: { tag: 'vip' } })
  })
  it('is deterministic (stable order across runs)', () => {
    expect(compileGraphToSteps(branched)).toEqual(compileGraphToSteps(branched))
  })
})

// SEQ-TERMINAL — the runner used to advance step_order+1 after every
// non-branch step, so a short yes-arm fell through into the no-arm
// (seq 21983d6c: already-booked leads still got the booking nudge).
// The compiler now stamps every non-branch step's real successor in
// config.next_step_order: the out-edge target's step_order, or 'end'
// when the node has no out-edges.
describe('compileGraphToSteps — successor stamping', () => {
  it('stamps intermediate nodes with their successor step_order', () => {
    const steps = compileGraphToSteps(linear)
    expect(steps[0].config.next_step_order).toBe(2)
  })

  it("stamps leaf nodes with 'end'", () => {
    const steps = compileGraphToSteps(linear)
    expect(steps[1].config.next_step_order).toBe('end')
  })

  it("stamps both terminal branch arms with 'end' (yes-arm must not fall into no-arm)", () => {
    const steps = compileGraphToSteps(branched)
    const yes = steps.find(s => s.step_type === 'email')
    const no = steps.find(s => s.step_type === 'sms')
    expect(yes.config.next_step_order).toBe('end')
    expect(no.config.next_step_order).toBe('end')
  })

  it('branch rows keep then/else pointers and gain no next_step_order', () => {
    const br = compileGraphToSteps(branched).find(s => s.step_type === 'branch')
    expect(br.config).not.toHaveProperty('next_step_order')
    expect(br.config.then_step_order).toBe(2)
    expect(br.config.else_step_order).toBe(3)
  })

  it('convergent arms: each arm points at the join node, jumping over the other arm', () => {
    const g = {
      version: 1,
      trigger: { type: 'manual', config: {} },
      nodes: [
        { id: 'br', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'attended' } } },
        { id: 'y', type: 'apply_tag', config: { tag: 'went' } },
        { id: 'n1', type: 'sms', config: { body: 'come back' } },
        { id: 'join', type: 'email', config: { subject: 'weekly', template_id: 't1' } },
      ],
      edges: [
        { from: 'trigger', to: 'br' },
        { from: 'br', to: 'y', label: 'yes' },
        { from: 'br', to: 'n1', label: 'no' },
        { from: 'y', to: 'join' },
        { from: 'n1', to: 'join' },
      ],
    }
    const steps = compileGraphToSteps(g)
    // BFS: br=1, y=2, n1=3, join=4
    const yStep = steps.find(s => s.step_type === 'apply_tag')
    const nStep = steps.find(s => s.step_type === 'sms')
    const join = steps.find(s => s.step_type === 'email')
    expect(yStep.step_order).toBe(2)
    expect(join.step_order).toBe(4)
    expect(yStep.config.next_step_order).toBe(4) // jumps OVER the no-arm
    expect(nStep.config.next_step_order).toBe(4)
    expect(join.config.next_step_order).toBe('end')
  })

  it('a stale next_step_order in authored node config is overridden by the computed one', () => {
    const g = {
      ...linear,
      nodes: [{ id: 'a', type: 'apply_tag', config: { tag: 'vip', next_step_order: 99 } }],
      edges: [{ from: 'trigger', to: 'a' }],
    }
    expect(compileGraphToSteps(g)[0].config.next_step_order).toBe('end')
  })
})
