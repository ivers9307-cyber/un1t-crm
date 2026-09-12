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
  // SEQ-URLBUTTON.1 — `url_button` is a RESERVED key inside whatsapp_variables,
  // not a numbered body variable. Nothing in compile/decompile enumerates the
  // keys, so it survives by accident rather than by design — pin it, because a
  // mapping that silently loses this key publishes a step Meta rejects with
  // 132012 on every single send.
  whatsapp_url_button: [
    { step_order: 1, step_type: 'whatsapp', whatsapp_template_id: 'wt-dyn', whatsapp_variables: { 1: 'first_name', url_button: 'abc' }, whatsapp_header_media_url: null },
  ],
  // SEQ-TERMINAL — graph-compiled shape: terminal yes-arm ends ('end'
  // marker) instead of falling through into the no-arm.
  terminal_arms: [
    { step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 'booked' }, then_step_order: 2, else_step_order: 3 } },
    { step_order: 2, step_type: 'apply_tag', config: { tag: 'already_booked', next_step_order: 'end' } },
    { step_order: 3, step_type: 'sms', sms_body: 'book your first class', config: { next_step_order: 'end' } },
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
    // The variable mapping is part of the row the runner reads — compare it
    // whenever there is one, so a key silently dropped in transit fails here.
    if (s.whatsapp_variables && Object.keys(s.whatsapp_variables).length) o.whatsapp_variables = s.whatsapp_variables
    // next_step_order is derived from the edges (SEQ-TERMINAL), so legacy
    // fixtures without it recompile with the marker added — for a legacy
    // markerless row 'next row' and the stamped successor are the same
    // advance, so drop it from the comparison.
    const { next_step_order, ...cfg } = s.config || {}
    void next_step_order
    if (Object.keys(cfg).length) o.config = cfg
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

describe('whatsapp_variables reserved keys survive the round trip (SEQ-URLBUTTON.1)', () => {
  it('keeps url_button alongside the numbered body variables', () => {
    const steps = fixtures.whatsapp_url_button
    const graph = decompileStepsToGraph(steps, { type: 'manual', config: {} })
    expect(graph.nodes[0].config.variables).toEqual({ 1: 'first_name', url_button: 'abc' })
    const [row] = compileGraphToSteps(graph)
    expect(row.whatsapp_variables).toEqual({ 1: 'first_name', url_button: 'abc' })
  })
})
