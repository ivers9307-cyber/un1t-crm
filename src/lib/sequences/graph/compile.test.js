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
