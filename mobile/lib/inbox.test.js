import { describe, it, expect } from 'vitest'
import {
  needsReply, isAgentHandoff, needsAction, hasPendingApproval,
  queueCounts, filterByQueue, mediaLabel, QUEUES,
} from './inbox'

// MOBILE-MSG.M1 — these predicates must match the web
// src/lib/inbox-queues.js semantics exactly so a conversation sits in
// the same queue on both surfaces: needsReply = unresolved + last
// message inbound; agent handoff = handed off + unresolved;
// needsAction = unresolved + (reply owed OR handed off) + has a
// last_message_at (SIDEBAR-BADGES.2 empty-shell guard). INBOX-EMAIL-M.1
// added needsAction/hasPendingApproval and the pending_approval queue.

const base = {
  resolved_at: null,
  agent_handed_off_at: null,
  last_message_direction: 'inbound',
  last_message_at: '2026-06-13T08:00:00Z',
}

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

describe('needsAction', () => {
  it('true for an unresolved inbound-last conversation with a last_message_at', () => {
    expect(needsAction({ ...base })).toBe(true)
  })
  it('true for an unresolved handoff even after we replied (outbound last)', () => {
    expect(needsAction({
      ...base,
      last_message_direction: 'outbound',
      agent_handed_off_at: '2026-06-13T09:00:00Z',
    })).toBe(true)
  })
  it('false once resolved', () => {
    expect(needsAction({ ...base, resolved_at: '2026-06-13T10:00:00Z' })).toBe(false)
    expect(needsAction({
      ...base,
      agent_handed_off_at: '2026-06-13T09:00:00Z',
      resolved_at: '2026-06-13T10:00:00Z',
    })).toBe(false)
  })
  it('false when we already replied and no handoff', () => {
    expect(needsAction({ ...base, last_message_direction: 'outbound' })).toBe(false)
  })
  it('empty-shell guard: no last_message_at never counts (SIDEBAR-BADGES.2)', () => {
    expect(needsAction({ ...base, last_message_at: null })).toBe(false)
    expect(needsAction({
      ...base,
      last_message_at: undefined,
      agent_handed_off_at: '2026-06-13T09:00:00Z',
    })).toBe(false)
  })
  it('false for null/undefined input', () => {
    expect(needsAction(null)).toBe(false)
    expect(needsAction(undefined)).toBe(false)
  })
})

describe('hasPendingApproval', () => {
  it('true when the route/backfill annotated a pending request', () => {
    expect(hasPendingApproval({ ...base, pending_approval: true })).toBe(true)
  })
  it('false when absent or false (email rows never carry the flag)', () => {
    expect(hasPendingApproval({ ...base })).toBe(false)
    expect(hasPendingApproval({ ...base, pending_approval: false })).toBe(false)
  })
  it('false for null/undefined input', () => {
    expect(hasPendingApproval(null)).toBe(false)
    expect(hasPendingApproval(undefined)).toBe(false)
  })
})

describe('queueCounts + filterByQueue', () => {
  const handoff = { ...base, id: 'a', agent_handed_off_at: '2026-06-13T09:00:00Z' }
  const inboundUnresolved = { ...base, id: 'b' }
  const replied = { ...base, id: 'c', last_message_direction: 'outbound' }
  const resolved = { ...base, id: 'd', resolved_at: '2026-06-13T10:00:00Z' }
  const withApproval = { ...base, id: 'e', pending_approval: true }
  const list = [handoff, inboundUnresolved, replied, resolved, withApproval]

  it('counts: handoff rows also count as needs-reply (chips are filters, not partitions)', () => {
    expect(queueCounts(list)).toEqual({ all: 5, needs_reply: 3, handoff: 1, pending_approval: 1 })
  })
  it('filters each queue', () => {
    expect(filterByQueue(list, 'all').map(c => c.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(filterByQueue(list, 'needs_reply').map(c => c.id)).toEqual(['a', 'b', 'e'])
    expect(filterByQueue(list, 'handoff').map(c => c.id)).toEqual(['a'])
    expect(filterByQueue(list, 'pending_approval').map(c => c.id)).toEqual(['e'])
  })
  it('unknown queue falls back to all; empty input is safe', () => {
    expect(filterByQueue(list, 'nope').length).toBe(5)
    expect(queueCounts([])).toEqual({ all: 0, needs_reply: 0, handoff: 0, pending_approval: 0 })
    expect(queueCounts(null)).toEqual({ all: 0, needs_reply: 0, handoff: 0, pending_approval: 0 })
  })
  it('QUEUES drives the chip strip in order', () => {
    expect(QUEUES.map(q => q.key)).toEqual(['all', 'needs_reply', 'handoff', 'pending_approval'])
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
