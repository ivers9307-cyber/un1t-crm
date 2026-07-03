import { describe, it, expect } from 'vitest'
import { EMIT_TOOL, buildAgentSystemPrompt, buildAgentUserMessage, buildFixMessage } from './prompt.js'
import { ACTIVE_NODE_TYPES, TRIGGER_SOURCE_ID } from '../graph/schema.js'

describe('flow agent prompt', () => {
  it('system prompt teaches the graph vocabulary + the structural rules', () => {
    const p = buildAgentSystemPrompt()
    // every ACTIVE node type is described; retired types (FUNNEL.1:
    // move_pipeline_stage) must NOT be offered to the agent at all.
    for (const t of ACTIVE_NODE_TYPES) expect(p).toContain(t)
    expect(p).not.toContain('move_pipeline_stage')
    // the reserved trigger source id + the key rules
    expect(p).toContain(TRIGGER_SOURCE_ID)
    expect(p).toContain('EXACTLY TWO outgoing edges')
    expect(p.toLowerCase()).toContain('no cycles')
    expect(p).toContain('emit_sequence_graph')
  })

  it('emit tool forces a {trigger, nodes, edges} object', () => {
    expect(EMIT_TOOL.name).toBe('emit_sequence_graph')
    expect(EMIT_TOOL.input_schema.required).toEqual(expect.arrayContaining(['trigger', 'nodes', 'edges']))
    expect(EMIT_TOOL.input_schema.properties.edges.items.properties.label.enum).toEqual(['yes', 'no'])
    expect(EMIT_TOOL.input_schema.properties.name).toBeDefined() // the agent also proposes a name
  })

  it('user message carries the trigger + the ask', () => {
    const msg = buildAgentUserMessage('a 3-step welcome flow', { type: 'tag_added', config: { tag: 'trial' } })
    expect(msg).toContain('tag_added')
    expect(msg).toContain('trial')
    expect(msg).toContain('a 3-step welcome flow')
  })

  it('fix message lists the validation problems', () => {
    const msg = buildFixMessage([{ message: 'SMS needs a body' }, { message: 'branch needs a no lane' }])
    expect(msg).toContain('SMS needs a body')
    expect(msg).toContain('branch needs a no lane')
    expect(msg).toContain('emit_sequence_graph')
  })

  it('documents the glofox_provision action and the contact_created trigger', () => {
    const p = buildAgentSystemPrompt()
    expect(p).toContain('glofox_provision')
    expect(p).toMatch(/Glofox account/i)
    expect(p).toContain('contact_created')
    expect(p).toMatch(/new lead/i)
  })
})
