import { describe, it, expect } from 'vitest'
import {
  isAgentMessage,
  classifyInboundTopic,
  summariseChannel,
  mergeSummaries,
  containmentRate,
  rankTopics,
} from './analytics.js'

describe('isAgentMessage', () => {
  it('true only for outbound source=agent', () => {
    expect(isAgentMessage({ direction: 'outbound', source: 'agent' })).toBe(true)
    expect(isAgentMessage({ direction: 'outbound', source: 'operator' })).toBe(false)
    expect(isAgentMessage({ direction: 'outbound', source: null })).toBe(false)
    expect(isAgentMessage({ direction: 'inbound', source: 'agent' })).toBe(false)
    expect(isAgentMessage(null)).toBe(false)
  })
})

describe('classifyInboundTopic', () => {
  it('buckets by keyword', () => {
    expect(classifyInboundTopic('I want to cancel my membership')).toBe('cancellation')
    expect(classifyInboundTopic('can I pause for a month?')).toBe('pause')
    expect(classifyInboundTopic('how much is a monthly membership?')).toBe('sales')
    expect(classifyInboundTopic('what time do you open today')).toBe('hours')
    expect(classifyInboundTopic('am I paid up and when is my next class')).toBe('account')
    expect(classifyInboundTopic('hey')).toBe('other')
    expect(classifyInboundTopic('')).toBe('other')
  })
  it('cancellation wins over pause when both present', () => {
    expect(classifyInboundTopic('I want to cancel, or maybe pause')).toBe('cancellation')
  })
})

describe('summariseChannel', () => {
  const convs = [
    { id: 'c1', agent_handed_off_at: null, agent_verified_contact_id: 'k1' },
    { id: 'c2', agent_handed_off_at: '2026-06-01T10:00:00Z', agent_verified_contact_id: null },
    { id: 'c3', agent_handed_off_at: null, agent_verified_contact_id: null },
  ]
  const msgs = [
    { conversation_id: 'c1', direction: 'inbound', body: 'how much to join?' },
    { conversation_id: 'c1', direction: 'outbound', source: 'agent', body: 'It is €X' },
    { conversation_id: 'c2', direction: 'inbound', body: 'I want to cancel' },
    { conversation_id: 'c2', direction: 'outbound', source: 'operator', body: 'human reply' },
    { conversation_id: 'c3', direction: 'inbound', body: 'when is my next class' },
    { conversation_id: 'c3', direction: 'outbound', source: 'agent', body: 'Tuesday' },
  ]
  it('counts replies, inbound, escalations, verified, topics', () => {
    const s = summariseChannel(convs, msgs)
    expect(s.conversations_total).toBe(3)
    expect(s.agent_replies).toBe(2)          // c1 + c3 agent outbound
    expect(s.agent_handled).toBe(2)          // distinct convs the agent spoke in
    expect(s.inbound_total).toBe(3)
    expect(s.escalated).toBe(1)              // c2 handed off
    expect(s.verified).toBe(1)               // c1
    expect(s.topics.sales).toBe(1)
    expect(s.topics.cancellation).toBe(1)
    expect(s.topics.account).toBe(1)
  })
  it('handles empty input', () => {
    expect(summariseChannel()).toEqual({
      conversations_total: 0, agent_handled: 0, escalated: 0,
      agent_replies: 0, inbound_total: 0, verified: 0, topics: {},
    })
  })
})

describe('mergeSummaries', () => {
  it('sums scalars and topic maps', () => {
    const a = { conversations_total: 2, agent_handled: 1, escalated: 1, agent_replies: 3, inbound_total: 4, verified: 1, topics: { sales: 2, pause: 1 } }
    const b = { conversations_total: 1, agent_handled: 1, escalated: 0, agent_replies: 1, inbound_total: 1, verified: 0, topics: { sales: 1, account: 1 } }
    const m = mergeSummaries(a, b)
    expect(m.conversations_total).toBe(3)
    expect(m.agent_replies).toBe(4)
    expect(m.escalated).toBe(1)
    expect(m.topics).toEqual({ sales: 3, pause: 1, account: 1 })
  })
  it('tolerates nulls', () => {
    expect(mergeSummaries(null, null).conversations_total).toBe(0)
  })
})

describe('containmentRate', () => {
  it('share of agent-handled that did not escalate', () => {
    expect(containmentRate({ agent_handled: 10, escalated: 2 })).toBe(80)
    expect(containmentRate({ agent_handled: 4, escalated: 4 })).toBe(0)
    expect(containmentRate({ agent_handled: 0, escalated: 0 })).toBe(null)
  })
  it('never returns negative', () => {
    expect(containmentRate({ agent_handled: 2, escalated: 5 })).toBe(0)
  })
})

describe('rankTopics', () => {
  it('orders most-asked first', () => {
    expect(rankTopics({ sales: 1, account: 5, pause: 3 })).toEqual([
      { topic: 'account', count: 5 },
      { topic: 'pause', count: 3 },
      { topic: 'sales', count: 1 },
    ])
  })
})

import { summariseActions } from './analytics'

// AGENT-ANALYTICS.2 — business outcomes from the audit trail.
describe('summariseActions', () => {
  it('groups audited requests into outcome counts', () => {
    const out = summariseActions([
      { kind: 'class_booking', status: 'actioned' },
      { kind: 'class_booking', status: 'actioned' },
      { kind: 'class_booking', status: 'failed' },
      { kind: 'event_booking', status: 'actioned' },
      { kind: 'consultation', status: 'actioned' },
      { kind: 'class_cancellation', status: 'actioned' },
      { kind: 'event_cancellation', status: 'pending' },
      { kind: 'pause', status: 'pending' },
    ])
    expect(out).toEqual({
      bookings: 4,            // class + event + consultation actioned
      cancellations: 1,       // actioned cancellations only
      failed: 1,
      pending_approvals: 2,   // anything still pending
    })
  })
  it('handles empty input', () => {
    expect(summariseActions([])).toEqual({ bookings: 0, cancellations: 0, failed: 0, pending_approvals: 0 })
  })
})
