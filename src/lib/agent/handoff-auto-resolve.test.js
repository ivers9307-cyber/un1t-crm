// MIA-BOARD.1 — the handoff exit. 121 handed-off threads sat parked with ZERO
// inbox resolves ever recorded (re-audit 25 Aug): the design assumed a manual
// step nobody takes. The sweep auto-resolves in two cases (Richard, 20 Aug):
//   (a) a human replied and the thread then went quiet for 8h
//   (b) nothing at all for 48h since the last activity
// Both apply the EXACT patch the inbox Resolve button applies
// (resolveRearmPatch + resolved_at), so semantics match the intended workflow.
// Threads an operator sticky-paused are never touched.
import { describe, it, expect } from 'vitest'
import {
  classifyAutoResolve,
  resolveAutoResolveHours,
  runHandoffAutoResolve,
} from './handoff-sla'
import { resolveRearmPatch } from './core'

const H = 3_600_000
const NOW = Date.parse('2026-08-25T12:00:00Z')

describe('resolveAutoResolveHours', () => {
  it('defaults to 8h after-reply and 48h stale', () => {
    expect(resolveAutoResolveHours(null)).toEqual({ afterReplyHours: 8, staleHours: 48 })
    expect(resolveAutoResolveHours({})).toEqual({ afterReplyHours: 8, staleHours: 48 })
  })
  it('honours operator values and treats 0 as disabled', () => {
    expect(resolveAutoResolveHours({ auto_resolve_after_reply_hours: 4, auto_resolve_stale_hours: 0 }))
      .toEqual({ afterReplyHours: 4, staleHours: 0 })
  })
  it('clamps junk to the defaults', () => {
    expect(resolveAutoResolveHours({ auto_resolve_after_reply_hours: 'soon', auto_resolve_stale_hours: -3 }))
      .toEqual({ afterReplyHours: 8, staleHours: 0 })
  })
})

describe('classifyAutoResolve', () => {
  const base = {
    handedOffAtMs: NOW - 24 * H,
    pausedAt: null,
    agentActive: false,
    resolvedAtMs: null,
    lastMessageAtMs: NOW - 10 * H,
    humanRepliedAtMs: NOW - 10 * H,
    nowMs: NOW,
    afterReplyHours: 8,
    staleHours: 48,
  }

  it('resolves after a human reply followed by quiet (case a)', () => {
    expect(classifyAutoResolve(base)).toEqual({ resolve: true, reason: 'human_replied_quiet' })
  })

  it('does not resolve while the conversation is still active', () => {
    expect(classifyAutoResolve({ ...base, lastMessageAtMs: NOW - 1 * H }).resolve).toBe(false)
  })

  it('never touches an operator-paused thread', () => {
    expect(classifyAutoResolve({ ...base, pausedAt: '2026-08-23T19:40:44Z' }))
      .toEqual({ resolve: false, reason: 'paused' })
  })

  it('skips threads the cooldown already re-armed', () => {
    expect(classifyAutoResolve({ ...base, agentActive: true }))
      .toEqual({ resolve: false, reason: 'already_armed' })
  })

  it('skips threads already resolved after the handoff', () => {
    expect(classifyAutoResolve({ ...base, resolvedAtMs: NOW - 2 * H }))
      .toEqual({ resolve: false, reason: 'already_resolved' })
  })

  it('resolves a fully stale thread even with no human reply (case b)', () => {
    const stale = {
      ...base,
      humanRepliedAtMs: null,
      lastMessageAtMs: NOW - 50 * H,
      handedOffAtMs: NOW - 50 * H,
    }
    expect(classifyAutoResolve(stale)).toEqual({ resolve: true, reason: 'stale' })
  })

  it('a human reply older than the handoff does not count for case a', () => {
    const oldReply = {
      ...base,
      humanRepliedAtMs: NOW - 30 * H, // before the handoff at -24h
      lastMessageAtMs: NOW - 30 * H,
    }
    const out = classifyAutoResolve(oldReply)
    expect(out.reason).not.toBe('human_replied_quiet')
  })

  it('0 disables each case independently', () => {
    expect(classifyAutoResolve({ ...base, afterReplyHours: 0 }).resolve).toBe(false)
    const stale = { ...base, humanRepliedAtMs: null, lastMessageAtMs: NOW - 60 * H, afterReplyHours: 0, staleHours: 0 }
    expect(classifyAutoResolve(stale).resolve).toBe(false)
  })

  it('falls back to the handoff time when the thread has no messages', () => {
    const noMsgs = { ...base, humanRepliedAtMs: null, lastMessageAtMs: null, handedOffAtMs: NOW - 49 * H }
    expect(classifyAutoResolve(noMsgs)).toEqual({ resolve: true, reason: 'stale' })
  })
})

describe('runHandoffAutoResolve', () => {
  function sweepDb({ convs }) {
    const updates = []
    const db = {
      from(table) {
        const state = { table }
        const finish = () => {
          if (state.op === 'update') return { data: null, error: null }
          if (table === 'locations') {
            return { data: [{ id: 'loc-1', name: 'Stillorgan', settings: { customer_agent: { enabled: true } } }], error: null }
          }
          if (table === 'whatsapp_conversations') return { data: convs, error: null }
          if (table === 'instagram_conversations') return { data: [], error: null }
          if (table.endsWith('_messages')) return { data: [], error: null }
          return { data: [], error: null }
        }
        const b = {
          select: () => b,
          update: (patch) => { state.op = 'update'; updates.push({ table, patch }); return b },
          eq: () => b, not: () => b, is: () => b, lt: () => b, gte: () => b,
          order: () => b, limit: () => b,
          then: (res, rej) => Promise.resolve(finish()).then(res, rej),
        }
        return b
      },
    }
    return { db, updates }
  }

  it('applies exactly the inbox-Resolve patch to a stale thread', async () => {
    const { db, updates } = sweepDb({
      convs: [{
        id: 'c1',
        agent_active: false,
        agent_handed_off_at: new Date(NOW - 80 * H).toISOString(),
        agent_paused_at: null,
        resolved_at: null,
        last_message_at: new Date(NOW - 79 * H).toISOString(),
      }],
    })
    const out = await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(out.resolved).toBe(1)
    expect(updates).toHaveLength(1)
    const patch = updates[0].patch
    // Byte-parity with the manual workflow: resolved_at + the re-arm patch.
    expect(patch).toEqual({
      resolved_at: new Date(NOW).toISOString(),
      ...resolveRearmPatch({ resolved: true, agent_handed_off_at: 'x' }),
    })
  })

  it('leaves a paused thread alone even when stale', async () => {
    const { db, updates } = sweepDb({
      convs: [{
        id: 'c1',
        agent_active: false,
        agent_handed_off_at: new Date(NOW - 80 * H).toISOString(),
        agent_paused_at: new Date(NOW - 81 * H).toISOString(),
        resolved_at: null,
        last_message_at: new Date(NOW - 79 * H).toISOString(),
      }],
    })
    const out = await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(out.resolved).toBe(0)
    expect(updates).toHaveLength(0)
  })
})
