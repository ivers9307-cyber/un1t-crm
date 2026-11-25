// MIA-BOARD.1 — the handoff exit. 121 handed-off threads sat parked with ZERO
// inbox resolves ever recorded (re-audit 25 Aug): the design assumed a manual
// step nobody takes. The sweep auto-resolves in two cases (Richard, 20 Aug):
//   (a) a human replied and the thread then went quiet for 8h
//   (b) nothing at all for 48h since the last activity, on a thread nobody is
//       waiting on (HANDOFFKEEP.1: an unanswered Mia handoff stays queued)
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
import { completePatch } from '@/lib/inbox-state'

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
  // MIAORG.1 T2-A — null / blank is UNSET (the default), never the 0 that
  // disables a case: Number(null) is 0.
  it('null / blank is unset, never 0 (disabled)', () => {
    expect(resolveAutoResolveHours({ auto_resolve_after_reply_hours: null, auto_resolve_stale_hours: null }))
      .toEqual({ afterReplyHours: 8, staleHours: 48 })
    expect(resolveAutoResolveHours({ auto_resolve_after_reply_hours: '', auto_resolve_stale_hours: ' ' }))
      .toEqual({ afterReplyHours: 8, staleHours: 48 })
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

  // INBOXFOLLOW.1 — a coach's thread stays theirs until a coach completes it.
  it('never auto-resolves a coach-owned thread, however long it is quiet', () => {
    expect(classifyAutoResolve({ ...base, staffOwned: true }))
      .toEqual({ resolve: false, reason: 'staff_owned' }) // human reply, 10 h quiet: case (a) today
    expect(classifyAutoResolve({ ...base, staffOwned: true, humanRepliedAtMs: null, customerWaiting: false, lastMessageAtMs: NOW - 49 * H }))
      .toEqual({ resolve: false, reason: 'staff_owned' }) // 49 h of nothing: case (b) today
    expect(classifyAutoResolve({ ...base, staffOwned: true, lastMessageAtMs: NOW - 60 * H }))
      .toEqual({ resolve: false, reason: 'staff_owned' })
  })

  it('keeps today\'s results when the thread is not coach-owned', () => {
    expect(classifyAutoResolve({ ...base, staffOwned: false })).toEqual({ resolve: true, reason: 'human_replied_quiet' })
    expect(classifyAutoResolve({ ...base, humanRepliedAtMs: null, customerWaiting: false, lastMessageAtMs: NOW - 49 * H, staffOwned: false }))
      .toEqual({ resolve: true, reason: 'stale' })
  })

  // INBOXFOLLOW.2 — a snoozed thread, or one whose reminder has fired, is a
  // coach's: the snooze columns are only cleared by a person or the customer.
  it('never auto-resolves a thread with an active snooze, in either case', () => {
    const snoozedUntilMs = NOW + 2 * H
    expect(classifyAutoResolve({ ...base, snoozedUntilMs })).toEqual({ resolve: false, reason: 'snoozed' }) // case a today
    expect(classifyAutoResolve({ ...base, snoozedUntilMs, humanRepliedAtMs: null, customerWaiting: false, lastMessageAtMs: NOW - 49 * H }))
      .toEqual({ resolve: false, reason: 'snoozed' }) // case b today
  })

  it('never auto-resolves a thread whose snooze has ended but was not cleared, in either case', () => {
    const snoozedUntilMs = NOW - 2 * H
    expect(classifyAutoResolve({ ...base, snoozedUntilMs })).toEqual({ resolve: false, reason: 'snoozed' })
    expect(classifyAutoResolve({ ...base, snoozedUntilMs, humanRepliedAtMs: null, customerWaiting: false, lastMessageAtMs: NOW - 49 * H }))
      .toEqual({ resolve: false, reason: 'snoozed' })
  })

  it('keeps today\'s results with no snooze', () => {
    expect(classifyAutoResolve({ ...base, snoozedUntilMs: null })).toEqual({ resolve: true, reason: 'human_replied_quiet' })
    expect(classifyAutoResolve({ ...base, humanRepliedAtMs: null, customerWaiting: false, lastMessageAtMs: NOW - 49 * H, snoozedUntilMs: null }))
      .toEqual({ resolve: true, reason: 'stale' })
  })

  it('skips threads the cooldown already re-armed', () => {
    expect(classifyAutoResolve({ ...base, agentActive: true }))
      .toEqual({ resolve: false, reason: 'already_armed' })
  })

  it('skips threads already resolved after the handoff', () => {
    expect(classifyAutoResolve({ ...base, resolvedAtMs: NOW - 2 * H }))
      .toEqual({ resolve: false, reason: 'already_resolved' })
  })

  // HANDOFFKEEP.1 — a customer Mia handed over, whom nobody answered, is still
  // waiting however long ago it was: the thread stays in the staff queue.
  it('keeps a stale handoff nobody answered in the queue (case b no longer applies)', () => {
    const stale = {
      ...base,
      humanRepliedAtMs: null,
      lastMessageAtMs: NOW - 50 * H,
      handedOffAtMs: NOW - 50 * H,
    }
    expect(classifyAutoResolve(stale)).toEqual({ resolve: false, reason: 'unanswered' })
    expect(classifyAutoResolve({ ...stale, customerWaiting: true })).toEqual({ resolve: false, reason: 'unanswered' })
    // However old it gets.
    expect(classifyAutoResolve({ ...stale, lastMessageAtMs: NOW - 900 * H, handedOffAtMs: NOW - 900 * H }).resolve).toBe(false)
  })

  it('still resolves a stale thread nobody is waiting on (a broadcast nobody answered)', () => {
    const stale = {
      ...base,
      humanRepliedAtMs: null,
      customerWaiting: false,
      lastMessageAtMs: NOW - 50 * H,
      handedOffAtMs: NOW - 50 * H,
    }
    expect(classifyAutoResolve(stale)).toEqual({ resolve: true, reason: 'stale' })
  })

  it('still resolves a stale thread a human did reply to when case a is off', () => {
    const replied = { ...base, afterReplyHours: 0, lastMessageAtMs: NOW - 50 * H, humanRepliedAtMs: NOW - 50 * H, handedOffAtMs: NOW - 60 * H }
    expect(classifyAutoResolve(replied)).toEqual({ resolve: true, reason: 'stale' })
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
    const stale = { ...base, humanRepliedAtMs: null, customerWaiting: false, lastMessageAtMs: NOW - 60 * H, afterReplyHours: 0, staleHours: 0 }
    expect(classifyAutoResolve(stale).resolve).toBe(false)
  })

  it('falls back to the handoff time when the thread has no messages', () => {
    const noMsgs = { ...base, humanRepliedAtMs: null, customerWaiting: false, lastMessageAtMs: null, handedOffAtMs: NOW - 49 * H }
    expect(classifyAutoResolve(noMsgs)).toEqual({ resolve: true, reason: 'stale' })
  })
})

describe('runHandoffAutoResolve', () => {
  // `messages(state)` answers a *_messages read; state.filters lists the
  // filter calls made, so a test can tell the human-reply read (or), the
  // broadcast read (not broadcast_id) and the customer-answer read (inbound).
  function sweepDb({ convs, messages = () => [] }) {
    const updates = []
    const db = {
      from(table) {
        const state = { table }
        const finish = () => {
          if (state.op === 'update') return { data: null, error: null }
          if (table === 'locations') {
            return { data: [{ id: 'loc-1', name: 'Stillorgan', organization_id: null, settings: { customer_agent: { enabled: true } } }], error: null }
          }
          if (table === 'whatsapp_conversations') return { data: convs, error: null }
          if (table === 'instagram_conversations') return { data: [], error: null }
          if (table.endsWith('_messages')) return { data: messages(state), error: null }
          return { data: [], error: null }
        }
        state.filters = []
        const note = (name) => (...args) => { state.filters.push([name, ...args]); return b }
        const b = {
          select: () => b,
          update: (patch) => { state.op = 'update'; updates.push({ table, patch }); return b },
          eq: note('eq'), not: note('not'), or: note('or'), is: note('is'), lt: note('lt'), lte: note('lte'), gt: note('gt'), gte: note('gte'), neq: note('neq'),
          order: () => b, limit: () => b,
          then: (res, rej) => Promise.resolve(finish()).then(res, rej),
        }
        return b
      },
    }
    return { db, updates }
  }

  const isBroadcastRead = (state) => state.filters.some(f => f[0] === 'not' && f[1] === 'broadcast_id')
  const isInboundRead = (state) => state.filters.some(f => f[0] === 'eq' && f[1] === 'direction' && f[2] === 'inbound')
  // A broadcast sits on the handoff stamp and the customer never answered it.
  const unansweredBroadcast = (state) => (isBroadcastRead(state) ? [{ created_at: new Date(NOW - 80 * H).toISOString() }] : [])

  it('applies exactly the inbox-Resolve patch to a stale thread', async () => {
    const { db, updates } = sweepDb({
      messages: unansweredBroadcast,
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
      ...completePatch(), // INBOXFOLLOW.1 — an auto-resolve completes the thread
    })
  })

  it('leaves a snoozed thread alone, active or ended, however stale', async () => {
    for (const snoozed_until of [new Date(NOW + 5 * H).toISOString(), new Date(NOW - 5 * H).toISOString()]) {
      const { db, updates } = sweepDb({
        messages: unansweredBroadcast, // would resolve as stale without the snooze
        convs: [{
          id: 'c4',
          agent_active: false,
          agent_handed_off_at: new Date(NOW - 80 * H).toISOString(),
          agent_paused_at: null,
          resolved_at: null,
          last_message_at: new Date(NOW - 79 * H).toISOString(),
          snoozed_until,
        }],
      })
      const out = await runHandoffAutoResolve(db, { nowMs: NOW })
      expect(out.resolved).toBe(0)
      expect(updates).toHaveLength(0)
    }
  })

  it('leaves a coach-owned thread alone, however stale', async () => {
    const { db, updates } = sweepDb({
      convs: [{
        id: 'c2',
        agent_active: false,
        agent_handed_off_at: new Date(NOW - 80 * H).toISOString(),
        agent_paused_at: null,
        resolved_at: null,
        last_message_at: new Date(NOW - 60 * H).toISOString(),
        staff_owned_since: new Date(NOW - 79 * H).toISOString(),
      }],
    })
    const out = await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(out.resolved).toBe(0)
    expect(updates).toHaveLength(0)
  })

  // HANDOFFKEEP.1 — the live case (22 Nov 2026): Mia told a customer she was
  // passing him to the team, nobody replied, and 48 hours later this sweep
  // took the thread out of the staff queue with his question still open.
  it('leaves a Mia handoff nobody answered in the queue, however stale', async () => {
    const { db, updates } = sweepDb({
      convs: [{
        id: 'c1',
        agent_active: false,
        agent_handed_off_at: new Date(NOW - 80 * H).toISOString(),
        agent_paused_at: null,
        resolved_at: null,
        last_message_at: new Date(NOW - 80 * H).toISOString(),
      }],
    })
    const out = await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(out.resolved).toBe(0)
    expect(out.unanswered).toBe(1)
    expect(updates).toHaveLength(0)
  })

  it('keeps a broadcast handover the customer answered and nobody replied to', async () => {
    const { db, updates } = sweepDb({
      messages: (state) => {
        if (isBroadcastRead(state)) return [{ created_at: new Date(NOW - 80 * H).toISOString() }]
        if (isInboundRead(state)) return [{ created_at: new Date(NOW - 79 * H).toISOString() }]
        return []
      },
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
    expect(out.resolved).toBe(0)
    expect(out.unanswered).toBe(1)
    expect(updates).toHaveLength(0)
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
