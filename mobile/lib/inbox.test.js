import { describe, it, expect } from 'vitest'
import { needsReply, isAgentHandoff, queueCounts, filterByQueue, mediaLabel, QUEUES } from './inbox'

// MOBILE-MSG.M1 — these predicates must match the web UnifiedInbox
// semantics exactly so a conversation sits in the same queue on both
// surfaces: needsReply = unresolved + last message inbound;
// agent handoff = handed off + unresolved.

const base = { resolved_at: null, agent_handed_off_at: null, last_message_direction: 'inbound' }

describe('needsReply', () => {
  it('true for an unresolved conversation whose last message is inbound', () => {
    expect(needsReply({ ...base })).toBe(true)
  })
  it('false once resolved', () => {
    expect(needsReply({ ...base, resolved_at: '2026-06-13T10:00:00Z' })).toBe(false)
  })
  it('false when the last message is outbound (we already replied)', () => {
    expect(needsReply({ ...base, last_message_direction: 'outbound' })).toBe(false)
  })
  it('false for null/undefined input', () => {
    expect(needsReply(null)).toBe(false)
    expect(needsReply(undefined)).toBe(false)
  })
})

describe('isAgentHandoff', () => {
  it('true when handed off and not resolved', () => {
    expect(isAgentHandoff({ ...base, agent_handed_off_at: '2026-06-13T09:00:00Z' })).toBe(true)
  })
  it('false once resolved (resolve hands the thread back to the agent)', () => {
    expect(isAgentHandoff({
      ...base,
      agent_handed_off_at: '2026-06-13T09:00:00Z',
      resolved_at: '2026-06-13T10:00:00Z',
    })).toBe(false)
  })
  it('false when never handed off', () => {
    expect(isAgentHandoff({ ...base })).toBe(false)
    expect(isAgentHandoff(null)).toBe(false)
  })
})

describe('queueCounts + filterByQueue', () => {
  const handoff = { ...base, id: 'a', agent_handed_off_at: '2026-06-13T09:00:00Z' }
  const inboundUnresolved = { ...base, id: 'b' }
  const replied = { ...base, id: 'c', last_message_direction: 'outbound' }
  const resolved = { ...base, id: 'd', resolved_at: '2026-06-13T10:00:00Z' }
  const list = [handoff, inboundUnresolved, replied, resolved]

  it('counts: handoff rows also count as needs-reply (chips are filters, not partitions)', () => {
    expect(queueCounts(list)).toEqual({ all: 4, needs_reply: 2, handoff: 1 })
  })
  it('filters each queue', () => {
    expect(filterByQueue(list, 'all').map(c => c.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterByQueue(list, 'needs_reply').map(c => c.id)).toEqual(['a', 'b'])
    expect(filterByQueue(list, 'handoff').map(c => c.id)).toEqual(['a'])
  })
  it('unknown queue falls back to all; empty input is safe', () => {
    expect(filterByQueue(list, 'nope').length).toBe(4)
    expect(queueCounts([])).toEqual({ all: 0, needs_reply: 0, handoff: 0 })
    expect(queueCounts(null)).toEqual({ all: 0, needs_reply: 0, handoff: 0 })
  })
  it('QUEUES drives the chip strip in order', () => {
    expect(QUEUES.map(q => q.key)).toEqual(['all', 'needs_reply', 'handoff'])
  })
})

describe('mediaLabel', () => {
  it('null for text and empty types (no chip)', () => {
    expect(mediaLabel('text')).toBe(null)
    expect(mediaLabel(null)).toBe(null)
    expect(mediaLabel(undefined)).toBe(null)
  })
  it('voice notes and audio both label as a voice note', () => {
    expect(mediaLabel('audio')).toEqual({ icon: 'mic-outline', label: 'Voice note' })
    expect(mediaLabel('voice')).toEqual({ icon: 'mic-outline', label: 'Voice note' })
  })
  it('common media types', () => {
    expect(mediaLabel('image')).toEqual({ icon: 'image-outline', label: 'Photo' })
    expect(mediaLabel('video')).toEqual({ icon: 'videocam-outline', label: 'Video' })
    expect(mediaLabel('document')).toEqual({ icon: 'document-outline', label: 'Document' })
    expect(mediaLabel('sticker')).toEqual({ icon: 'happy-outline', label: 'Sticker' })
    expect(mediaLabel('location')).toEqual({ icon: 'location-outline', label: 'Location' })
    expect(mediaLabel('contacts')).toEqual({ icon: 'person-outline', label: 'Contact card' })
  })
  it('unknown types still get a generic attachment chip', () => {
    expect(mediaLabel('order')).toEqual({ icon: 'attach-outline', label: 'order' })
  })
})
