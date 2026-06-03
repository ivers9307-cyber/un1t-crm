import { describe, it, expect } from 'vitest'
import {
  NODE_TYPES, TRIGGER_TYPES, CHANNEL_NODE_TYPES, CONFIG_NODE_TYPES,
  TRIGGER_SOURCE_ID, isChannelNode, parseGraphShape,
} from './schema.js'

describe('graph schema constants', () => {
  it('lists the 10 node types', () => {
    expect(NODE_TYPES).toEqual([
      'email', 'whatsapp', 'sms', 'wait', 'apply_tag', 'update_field',
      'internal_task', 'webhook', 'branch', 'move_pipeline_stage',
    ])
  })
  it('splits channel vs config nodes', () => {
    expect(CHANNEL_NODE_TYPES).toEqual(['email', 'whatsapp', 'sms', 'wait'])
    expect(CONFIG_NODE_TYPES).toContain('branch')
    expect(CONFIG_NODE_TYPES).not.toContain('email')
    expect(isChannelNode('sms')).toBe(true)
    expect(isChannelNode('branch')).toBe(false)
  })
  it('includes the engine trigger vocabulary', () => {
    for (const t of ['manual', 'booking_created', 'pipeline_stage_change', 'tag_added',
      'event_reminder', 'segment_added', 'segment_removed', 'anniversary', 'inactivity']) {
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
