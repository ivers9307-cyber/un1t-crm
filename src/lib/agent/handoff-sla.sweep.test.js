// C21 PUSHDONE.1 — the handoff escalation is stamped AFTER the push. It used to
// stamp first, so a push that reached nobody (Expo down, a failed read) was
// recorded as "managers alerted" and the customer waited on in silence.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { sendPushToRolesAtLocation } = await import('@/lib/push')
const { logWarn, logError } = await import('@/lib/log')
const { runHandoffSlaSweep, runHandoffAutoResolve, HANDOFF_ALERT_RETRY_HOURS } = await import('./handoff-sla')

const H = 3_600_000
const NOW = Date.parse('2026-09-28T12:00:00Z')

// One WhatsApp conversation handed off 2h ago (SLA 60 min), nobody replied.
// `updates` records every UPDATE with its filters, in order.
// `readErrors` fails the SELECT on the named table (C31 PUSHNITS.1).
function sweepDb({ convs, updateError = null, readErrors = {} } = {}) {
  const updates = []
  const db = {
    from(table) {
      const state = { eqs: {}, is: {} }
      const b = {
        select: () => b, not: () => b, lt: () => b, gte: () => b, neq: () => b,
        order: () => b, limit: () => b,
        eq: (c, v) => { state.eqs[c] = v; return b },
        is: (c, v) => { state.is[c] = v; return b },
        update(patch) { state.patch = patch; updates.push({ table, patch, eqs: state.eqs, is: state.is }); return b },
        then(res, rej) {
          let out
          if (state.patch) out = { data: null, error: updateError }
          else if (readErrors[table]) out = { data: null, error: readErrors[table] }
          else if (table === 'locations') out = { data: [{ id: 'loc-1', name: 'Studio', settings: { customer_agent: { enabled: true } } }], error: null }
          else if (table === 'whatsapp_conversations') out = { data: convs, error: null }
          else out = { data: [], error: null } // no human reply; no Instagram threads
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }
  return { db, updates }
}

const conv = (handedOffAgoMs = 2 * H) => ({
  id: 'conv-1', contact_id: 'c1', resolved_at: null,
  agent_handed_off_at: new Date(NOW - handedOffAgoMs).toISOString(),
  handoff_escalated_at: null, last_message_preview: null, contacts: { first_name: 'Sam' },
})
const stampOf = (updates) => updates.find((u) => 'handoff_escalated_at' in u.patch)

beforeEach(() => {
  vi.clearAllMocks()
  sendPushToRolesAtLocation.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
})

describe('runHandoffSlaSweep — stamp after the send (C21 PUSHDONE.1)', () => {
  it('pushes, THEN stamps, with a CAS on the null stamp', async () => {
    const { db, updates } = sweepDb({ convs: [conv()] })
    let stampedBeforeSend = null
    sendPushToRolesAtLocation.mockImplementationOnce(async () => { stampedBeforeSend = !!stampOf(updates); return { sent: 1 } })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(stampedBeforeSend).toBe(false)
    expect(stampOf(updates)).toMatchObject({ table: 'whatsapp_conversations', eqs: { id: 'conv-1' }, is: { handoff_escalated_at: null } })
    expect(out).toMatchObject({ escalated: 1, alert_failed: 0 })
  })

  it('a push that reached nobody because it FAILED is not stamped; the next tick retries', async () => {
    const { db, updates } = sweepDb({ convs: [conv()] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 2, read_failed: 1 })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeUndefined()
    expect(out).toMatchObject({ escalated: 0, alert_failed: 1 })
    expect(logWarn).toHaveBeenCalledWith('handoff-sla', 'escalation reached nobody; not stamped, retried next tick',
      expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv-1', read_failed: true }))
  })

  it('a throwing push is a failure too', async () => {
    const { db, updates } = sweepDb({ convs: [conv()] })
    sendPushToRolesAtLocation.mockRejectedValueOnce(new Error('boom'))
    await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeUndefined()
  })

  it('a failed role read (recipients_failed) is a failure, not "nobody to tell"', async () => {
    const { db, updates } = sweepDb({ convs: [conv()] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 })
    await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeUndefined()
  })

  it('nobody to tell (sent 0, failed 0) is stamped: nothing to retry against', async () => {
    const { db, updates } = sweepDb({ convs: [conv()] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 2, invalidated: 0, failed: 0 })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeTruthy()
    expect(out.escalated).toBe(1)
  })

  it('past the retry window a failing escalation is stamped and given up at error level', async () => {
    const { db, updates } = sweepDb({ convs: [conv((HANDOFF_ALERT_RETRY_HOURS + 2) * H)] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, failed: 1 })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeTruthy()
    expect(out).toMatchObject({ escalated: 0, gave_up: 1 })
    expect(logError).toHaveBeenCalledWith('handoff-sla', 'escalation never reached a manager; gave up',
      expect.objectContaining({ conversationId: 'conv-1' }))
  })

  it('a failed stamp after a delivered push is said at error level', async () => {
    const { db } = sweepDb({ convs: [conv()], updateError: { message: 'down' } })
    await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(logError).toHaveBeenCalledWith('handoff-sla', 'escalation stamp failed; managers may be alerted again next tick',
      expect.objectContaining({ conversationId: 'conv-1', err: 'down' }))
  })
})

describe('runHandoffAutoResolve — a failed resolve write is not counted as resolved', () => {
  it('logs, counts skipped, and leaves the thread for the next tick', async () => {
    const stale = { id: 'conv-2', agent_active: false, agent_handed_off_at: new Date(NOW - 72 * H).toISOString(), agent_paused_at: null, resolved_at: null, last_message_at: null }
    const { db } = sweepDb({ convs: [stale], updateError: { message: 'down' } })
    const out = await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(out).toEqual({ resolved: 0, skipped: 1, reply_unread: 0, locations_unread: 0 })
    expect(logWarn).toHaveBeenCalledWith('handoff-sla', 'auto-resolve write failed; retried next tick',
      expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv-2', err: 'down' }))
  })
})

// C31 PUSHNITS.1 — a failed read is never an empty answer.
describe('a failed read is not "no reply" / "no candidates" (C31 PUSHNITS.1)', () => {
  const DOWN = { code: 'XX000', message: 'down' }

  it('SLA sweep: an unreadable human-reply check skips the thread this tick (no push, no stamp)', async () => {
    const { db, updates } = sweepDb({ convs: [conv()], readErrors: { whatsapp_messages: DOWN } })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    expect(stampOf(updates)).toBeUndefined()
    expect(out).toMatchObject({ escalated: 0, reply_unread: 1 })
    expect(logError).toHaveBeenCalledWith('handoff-sla', 'human-reply read failed; not escalated, retried next tick',
      expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv-1', err: 'down' }))
  })

  it('SLA sweep: past the retry window an unreadable reply check escalates anyway (a waiting customer is never dropped)', async () => {
    const { db, updates } = sweepDb({ convs: [conv((HANDOFF_ALERT_RETRY_HOURS + 2) * H)], readErrors: { whatsapp_messages: DOWN } })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    expect(stampOf(updates)).toBeTruthy()
    expect(out).toMatchObject({ escalated: 1, reply_unread: 1 })
  })

  it('auto-resolve: an unreadable human-reply check leaves the thread alone this tick', async () => {
    const stale = { id: 'conv-2', agent_active: false, agent_handed_off_at: new Date(NOW - 72 * H).toISOString(), agent_paused_at: null, resolved_at: null, last_message_at: null }
    const { db, updates } = sweepDb({ convs: [stale], readErrors: { whatsapp_messages: DOWN } })
    const out = await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(updates).toEqual([])
    expect(out).toMatchObject({ resolved: 0, skipped: 1 })
    expect(logError).toHaveBeenCalledWith('handoff-sla', 'human-reply read failed; not auto-resolved, retried next tick',
      expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv-2', err: 'down' }))
  })

  it.each([
    ['runHandoffSlaSweep', runHandoffSlaSweep],
    ['runHandoffAutoResolve', runHandoffAutoResolve],
  ])('%s: a failed candidate read is logged structurally, never free text', async (_name, run) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = sweepDb({ convs: [], readErrors: { whatsapp_conversations: DOWN } })
    await run(db, { nowMs: NOW })
    expect(logError).toHaveBeenCalledWith('handoff-sla', expect.stringMatching(/candidate read failed/),
      expect.objectContaining({ channel: 'whatsapp', locationId: 'loc-1', err: 'down' }))
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it.each([
    ['runHandoffSlaSweep', runHandoffSlaSweep],
    ['runHandoffAutoResolve', runHandoffAutoResolve],
  ])('%s: a failed locations read is said, not a quiet run', async (_name, run) => {
    const { db } = sweepDb({ convs: [], readErrors: { locations: DOWN } })
    const out = await run(db, { nowMs: NOW })
    expect(out.locations_unread).toBe(1)
    expect(logError).toHaveBeenCalledWith('handoff-sla', expect.stringMatching(/locations read failed/), expect.objectContaining({ err: 'down' }))
  })
})
