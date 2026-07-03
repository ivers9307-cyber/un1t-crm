import { describe, it, expect } from 'vitest'
import {
  NODE_TYPES, ACTIVE_NODE_TYPES, RETIRED_NODE_TYPES,
  TRIGGER_TYPES, CHANNEL_NODE_TYPES, CONFIG_NODE_TYPES,
  TRIGGER_SOURCE_ID, isChannelNode, parseGraphShape,
} from './schema.js'

describe('graph schema constants', () => {
  it('lists the 11 node types', () => {
    expect(NODE_TYPES).toEqual([
      'email', 'whatsapp', 'sms', 'wait', 'apply_tag', 'update_field',
      'internal_task', 'webhook', 'branch', 'move_pipeline_stage', 'glofox_provision',
    ])
  })
  it('move_pipeline_stage is retired: still parseable (legacy drafts) but never offered', () => {
    // FUNNEL.1 — stage placement is classifier-derived. The type stays
    // in NODE_TYPES so legacy drafts pass the whole-graph shape check
    // on save; ACTIVE_NODE_TYPES (palette + AI vocabulary) excludes it.
    expect(RETIRED_NODE_TYPES).toEqual(['move_pipeline_stage'])
    expect(NODE_TYPES).toContain('move_pipeline_stage')
    expect(ACTIVE_NODE_TYPES).not.toContain('move_pipeline_stage')
    expect(ACTIVE_NODE_TYPES).toEqual(NODE_TYPES.filter((t) => t !== 'move_pipeline_stage'))
    // A legacy graph containing the retired node must still parse.
    const legacy = {
      version: 1,
      trigger: { type: 'tag_added', config: { tag: 'glofox_trial_engaged' } },
      nodes: [{ id: 'n1', type: 'move_pipeline_stage', config: { stage_slug: 'conversion_ready' } }],
      edges: [{ from: 'trigger', to: 'n1' }],
    }
    expect(parseGraphShape(legacy).ok).toBe(true)
  })
  it('splits channel vs config nodes', () => {
    expect(CHANNEL_NODE_TYPES).toEqual(['email', 'whatsapp', 'sms', 'wait'])
    expect(CONFIG_NODE_TYPES).toContain('branch')
    expect(CONFIG_NODE_TYPES).toContain('glofox_provision')
    expect(CONFIG_NODE_TYPES).not.toContain('email')
    expect(isChannelNode('sms')).toBe(true)
    expect(isChannelNode('branch')).toBe(false)
  })
  it('includes the engine trigger vocabulary', () => {
    for (const t of ['manual', 'booking_created', 'pipeline_stage_change', 'tag_added',
      'event_reminder', 'segment_added', 'segment_removed', 'anniversary', 'inactivity',
      'contact_created']) {
      expect(TRIGGER_TYPES).toContain(t)
    }
  })
  it('reserves the trigger source id', () => {
    expect(TRIGGER_SOURCE_ID).toBe('trigger')
  })
})

describe('parseGraphShape', () => {
  const good = {
    version: 1,
    trigger: { type: 'manual', config: {} },
    nodes: [{ id: 'n1', type: 'sms', config: { body: 'hi' } }],
    edges: [{ from: 'trigger', to: 'n1' }],
  }
  it('accepts a well-formed graph', () => {
    const r = parseGraphShape(good)
    expect(r.ok).toBe(true)
  })
  it('rejects a missing trigger', () => {
    const r = parseGraphShape({ version: 1, nodes: [], edges: [] })
    expect(r.ok).toBe(false)
  })
  it('rejects an unknown node type', () => {
    const r = parseGraphShape({ ...good, nodes: [{ id: 'n1', type: 'telepathy', config: {} }] })
    expect(r.ok).toBe(false)
  })
  it('rejects an edge label that is not yes/no', () => {
    const r = parseGraphShape({ ...good, edges: [{ from: 'trigger', to: 'n1', label: 'maybe' }] })
    expect(r.ok).toBe(false)
  })
})
