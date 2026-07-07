import { describe, it, expect } from 'vitest'
import { needsReply, isAgentHandoff, needsAction } from './inbox-queues'

const base = { last_message_at: '2026-07-07T11:00:00Z', resolved_at: null, last_message_direction: 'inbound', agent_handed_off_at: null }

describe('needsReply', () => {
  it('true when unresolved and the last message is inbound', () => {
    expect(needsReply(base)).toBe(true)
  })
  it('false once resolved, or when the last message was outbound', () => {
    expect(needsReply({ ...base, resolved_at: '2026-07-07T12:00:00Z' })).toBe(false)
    expect(needsReply({ ...base, last_message_direction: 'outbound' })).toBe(false)
  })
})

describe('isAgentHandoff', () => {
  it('true when handed off and not resolved', () => {
    expect(isAgentHandoff({ ...base, agent_handed_off_at: '2026-07-07T11:24:00Z' })).toBe(true)
  })
  it('false when resolved or never handed off', () => {
    expect(isAgentHandoff({ ...base, agent_handed_off_at: '2026-07-07T11:24:00Z', resolved_at: '2026-07-07T12:00:00Z' })).toBe(false)
    expect(isAgentHandoff(base)).toBe(false)
  })
})

describe('needsAction (the badge signal)', () => {
  it('counts an unanswered inbound even when unread_count is 0 (opened-but-unanswered) — the Liam case', () => {
    // unread_count is irrelevant to the predicate; an opened thread that still
    // awaits a reply must badge.
    expect(needsAction(base)).toBe(true)
  })
  it('counts a handed-off thread whose last line was the agent (outbound) — the Mahishi case', () => {
    expect(needsAction({ ...base, last_message_direction: 'outbound', agent_handed_off_at: '2026-07-07T11:24:00Z' })).toBe(true)
  })
  it('does NOT count resolved threads', () => {
    expect(needsAction({ ...base, resolved_at: '2026-07-07T12:00:00Z' })).toBe(false)
    expect(needsAction({ ...base, agent_handed_off_at: '2026-07-07T11:24:00Z', resolved_at: '2026-07-07T12:00:00Z' })).toBe(false)
  })
  it('does NOT count an outbound-last thread that was never handed off (we already replied)', () => {
    expect(needsAction({ ...base, last_message_direction: 'outbound' })).toBe(false)
  })
  it('ignores empty conversation shells with no messages (no last_message_at)', () => {
    expect(needsAction({ ...base, last_message_at: null, agent_handed_off_at: '2026-07-07T11:24:00Z', last_message_direction: null })).toBe(false)
  })
  it('is null-safe', () => {
    expect(needsAction(null)).toBe(false)
    expect(needsAction(undefined)).toBe(false)
  })
})
