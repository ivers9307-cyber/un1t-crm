import { describe, it, expect } from 'vitest'
import { buildBackfillUpdates } from './backfill.js'

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
