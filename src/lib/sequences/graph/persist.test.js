import { describe, it, expect } from 'vitest'
import { resolveSequenceGraph, compileForPublish } from './persist.js'

// A published canonical graph (one SMS step).
const publishedGraph = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'sms', config: { body: 'published' } }],
  edges: [{ from: 'trigger', to: 'n1' }],
}
// A draft (work-in-progress) graph — note it is allowed to be richer.
const draftGraph = {
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'sms', config: { body: 'draft edit' } }],
  edges: [{ from: 'trigger', to: 'n1' }],
}

describe('resolveSequenceGraph — what the builder opens', () => {
  it('prefers the draft graph when one exists (resume an edit)', () => {
    const seq = { graph: publishedGraph, draft_graph: draftGraph, sequence_steps: [] }
    expect(resolveSequenceGraph(seq)).toBe(draftGraph)
  })

  it('ignores the draft when preferDraft:false (what is actually live)', () => {
    const seq = { graph: publishedGraph, draft_graph: draftGraph, sequence_steps: [] }
    expect(resolveSequenceGraph(seq, { preferDraft: false })).toBe(publishedGraph)
  })

  it('falls back to the published graph when there is no draft', () => {
    const seq = { graph: publishedGraph, draft_graph: null, sequence_steps: [] }
    expect(resolveSequenceGraph(seq)).toBe(publishedGraph)
  })

  it('lazily decompiles live steps when neither graph nor draft exists (the deferred backfill)', () => {
    // A legacy sequence that predates the graph column: graph + draft are null,
    // so the builder reconstructs the graph from sequence_steps on first open.
    const seq = {
      graph: null,
      draft_graph: null,
      trigger_type: 'manual',
      trigger_config: {},
      sequence_steps: [
        { step_order: 2, step_type: 'sms', sms_body: 'second' },
        { step_order: 1, step_type: 'sms', sms_body: 'first' },
      ],
    }
    const g = resolveSequenceGraph(seq)
    expect(g.nodes).toHaveLength(2)
    // decompile sorts by step_order, so n1 is the first node, fed by the trigger.
    expect(g.edges).toContainEqual({ from: 'trigger', to: 'n1' })
    expect(g.nodes[0]).toMatchObject({ id: 'n1', type: 'sms' })
  })

  it('decompiles using the sequence trigger columns', () => {
    const seq = {
      graph: null, draft_graph: null,
      trigger_type: 'booking_created', trigger_config: { event_type_id: 'abc' },
      sequence_steps: [{ step_order: 1, step_type: 'sms', sms_body: 'hi' }],
    }
    expect(resolveSequenceGraph(seq).trigger).toEqual({
      type: 'booking_created', config: { event_type_id: 'abc' },
    })
  })

  it('returns an empty graph (trigger only) for a brand-new sequence with no steps', () => {
    const seq = { graph: null, draft_graph: null, trigger_type: 'manual', sequence_steps: [] }
    const g = resolveSequenceGraph(seq)
    expect(g.nodes).toEqual([])
    expect(g.trigger.type).toBe('manual')
  })

  it('returns null for a missing sequence', () => {
    expect(resolveSequenceGraph(null)).toBeNull()
  })
})

describe('compileForPublish — the publish gate', () => {
  it('compiles a valid graph to step rows', () => {
    const r = compileForPublish(publishedGraph)
    expect(r.ok).toBe(true)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]).toMatchObject({ step_order: 1, step_type: 'sms', sms_body: 'published' })
  })

  it('refuses an invalid graph and surfaces the validation errors', () => {
    const bad = {
      version: 1,
      trigger: { type: 'manual', config: {} },
      nodes: [{ id: 'n1', type: 'sms', config: {} }], // SMS with no body
      edges: [{ from: 'trigger', to: 'n1' }],
    }
    const r = compileForPublish(bad)
    expect(r.ok).toBe(false)
    expect(r.steps).toBeUndefined()
    expect(r.errors.map(e => e.code)).toContain('missing_config')
  })

  it('rejects a structurally malformed graph (not a graph at all)', () => {
    const r = compileForPublish({ nodes: [] })
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('shape')
  })
})
