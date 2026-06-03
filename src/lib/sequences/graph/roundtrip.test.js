import { describe, it, expect } from 'vitest'
import { compileGraphToSteps } from './compile.js'
import { decompileStepsToGraph } from './decompile.js'
import { validateGraph } from './validate.js'

// Fixtures shaped like real prod sequence_steps.
const fixtures = {
  linear: [
    { step_order: 1, step_type: 'wait', delay_days: 0, delay_hours: 1, delay_minutes: 0 },
    { step_order: 2, step_type: 'whatsapp', whatsapp_template_id: 'wt1', whatsapp_variables: { 1: 'first_name' }, whatsapp_header_media_url: null },
    { step_order: 3, step_type: 'email', subject: 'Hi', html_content: '<p>hi</p>', template_id: null },
  ],
  branched: [
    { step_order: 1, step_type: 'wait', delay_days: 2, delay_hours: 0, delay_minutes: 0 },
    { step_order: 2, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 'attended' }, then_step_order: 3, else_step_order: 4 } },
    { step_order: 3, step_type: 'email', subject: 'How was it?', html_content: null, template_id: 't9' },
    { step_order: 4, step_type: 'sms', sms_body: 'come back this week' },
  ],
}

// Compare only the fields the runner reads (ignore defaulted nulls/empties).
function normalise(steps) {
  return steps.map(s => {
    const o = { step_order: s.step_order, step_type: s.step_type }
    // A delay of 0 is identical to "no delay" to the runner, so only count
    // non-zero delays (the compiler stamps 0/0/0 on every row by design).
    for (const k of ['delay_days', 'delay_hours', 'delay_minutes']) {
      if (s[k]) o[k] = s[k]
    }
    for (const k of ['subject', 'html_content', 'template_id', 'sms_body', 'whatsapp_template_id']) {
      if (s[k] != null) o[k] = s[k]
    }
    if (s.config) o.config = s.config
    return o
  })
}

describe('graph round-trip — decompile then recompile equals the input', () => {
  for (const [name, steps] of Object.entries(fixtures)) {
    it(`${name}: compile(decompile(steps)) ≈ steps`, () => {
      const graph = decompileStepsToGraph(steps, { type: 'manual', config: {} })
      expect(validateGraph(graph).ok).toBe(true)
      const recompiled = compileGraphToSteps(graph)
      expect(normalise(recompiled)).toEqual(normalise(steps))
    })
  }
})
