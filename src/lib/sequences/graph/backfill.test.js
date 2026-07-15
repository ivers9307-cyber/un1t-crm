import { describe, it, expect } from 'vitest'
import { buildBackfillUpdates, buildMarkerBackfillUpdates } from './backfill.js'

describe('buildBackfillUpdates', () => {
  it('produces one {id, graph} update per sequence, skipping those already backfilled', () => {
    const rows = [
      { id: 's1', trigger_type: 'manual', trigger_config: {}, graph: null,
        steps: [{ step_order: 1, step_type: 'sms', sms_body: 'hi' }] },
      { id: 's2', trigger_type: 'booking_created', trigger_config: { event_type_id: 'e' }, graph: { version: 1 },
        steps: [{ step_order: 1, step_type: 'wait', delay_days: 1 }] },
    ]
    const out = buildBackfillUpdates(rows)
    expect(out.map(u => u.id)).toEqual(['s1']) // s2 already has a graph → skipped
    expect(out[0].graph.trigger).toEqual({ type: 'manual', config: {} })
    expect(out[0].graph.nodes[0].type).toBe('sms')
  })
})

// SEQ-TERMINAL — one-time healing of steps compiled before the compiler
// stamped config.next_step_order: recompile each stored graph and emit a
// per-step config update adding the marker, preserving the row's config.
describe('buildMarkerBackfillUpdates', () => {
  const graph = {
    version: 1,
    trigger: { type: 'contact_created', config: {} },
    nodes: [
      { id: 'br', type: 'branch', config: { predicate: { type: 'has_tag', tag: 'booked' } } },
      { id: 'y', type: 'apply_tag', config: { tag: 'already_booked' } },
      { id: 'n', type: 'whatsapp', config: { template_id: 'book_first_visit' } },
    ],
    edges: [
      { from: 'trigger', to: 'br' },
      { from: 'br', to: 'y', label: 'yes' },
      { from: 'br', to: 'n', label: 'no' },
    ],
  }
  const steps = [
    { id: 'row-1', step_order: 1, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 'booked' }, then_step_order: 2, else_step_order: 3 } },
    { id: 'row-2', step_order: 2, step_type: 'apply_tag', config: { tag: 'already_booked' } },
    { id: 'row-3', step_order: 3, step_type: 'whatsapp', whatsapp_template_id: 'book_first_visit', config: null },
  ]

  it('emits marker updates for unmarked non-branch steps, preserving existing config', () => {
    const { updates, skipped } = buildMarkerBackfillUpdates([{ id: 's1', graph, steps }])
    expect(skipped).toEqual([])
    expect(updates).toEqual([
      { sequenceId: 's1', stepId: 'row-2', config: { tag: 'already_booked', next_step_order: 'end' } },
      { sequenceId: 's1', stepId: 'row-3', config: { next_step_order: 'end' } },
    ])
  })

  it('is idempotent — steps already carrying the correct marker produce no update', () => {
    const marked = steps.map(s => s.step_type === 'branch' ? s : { ...s, config: { ...(s.config || {}), next_step_order: 'end' } })
    const { updates } = buildMarkerBackfillUpdates([{ id: 's1', graph, steps: marked }])
    expect(updates).toEqual([])
  })

  it('skips a sequence whose steps diverge from its graph (step_type mismatch) and reports it', () => {
    const diverged = [steps[0], { ...steps[1], step_type: 'sms', sms_body: 'x' }, steps[2]]
    const { updates, skipped } = buildMarkerBackfillUpdates([{ id: 's1', graph, steps: diverged }])
    expect(updates).toEqual([])
    expect(skipped).toEqual([{ id: 's1', reason: expect.stringContaining('step_order 2') }])
  })

  it('skips sequences with no graph or no steps', () => {
    const { updates, skipped } = buildMarkerBackfillUpdates([
      { id: 's1', graph: null, steps },
      { id: 's2', graph, steps: [] },
    ])
    expect(updates).toEqual([])
    expect(skipped).toEqual([])
  })
})
