// C21 PUSHDONE.1 — the handoff escalation is stamped AFTER the push. It used to
// stamp first, so a push that reached nobody (Expo down, a failed read) was
// recorded as "managers alerted" and the customer waited on in silence.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { sendPushToRolesAtLocation } = await import('@/lib/push')
const { logWarn, logError } = await import('@/lib/log')
const { runHandoffSlaSweep, runHandoffAutoResolve, HANDOFF_ALERT_RETRY_HOURS, HANDOFF_REPLY_UNREAD_GRACE_MINUTES } = await import('./handoff-sla')

const H = 3_600_000
const NOW = Date.parse('2026-09-28T12:00:00Z')

// One WhatsApp conversation handed off 2h ago (SLA 60 min), nobody replied.
// `updates` records every UPDATE with its filters, in order.
// `readErrors` fails the SELECT on the named table (C31 PUSHNITS.1).
// `replies` is what the human-reply read returns (default: nobody replied).
// The conversations read honours `.is('handoff_escalated_at', null)`, and a
// successful UPDATE applies to the in-memory row only when its `.is()` CAS
// still holds, so several ticks can run against the same fake.
function sweepDb({ convs, updateError = null, readErrors = {}, replies = [] } = {}) {
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
          const casHolds = (row) => Object.entries(state.is).every(([c, v]) => (row[c] ?? null) === v)
          if (state.patch) {
            out = { data: null, error: updateError }
            if (!updateError && table === 'whatsapp_conversations') {
              for (const row of convs || []) if (row.id === state.eqs.id && casHolds(row)) Object.assign(row, state.patch)
            }
          } else if (readErrors[table]) out = { data: null, error: readErrors[table] }
          else if (table === 'locations') out = { data: [{ id: 'loc-1', name: 'Studio', settings: { customer_agent: { enabled: true } } }], error: null }
          else if (table === 'whatsapp_conversations') out = { data: (convs || []).filter(casHolds), error: null }
          else if (table === 'whatsapp_messages') out = { data: replies, error: null }
          else out = { data: [], error: null } // no Instagram threads
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

  // SLA is 60 min in these fixtures, so "handed off 60 + n minutes ago" is n minutes past the breach.
  const M = 60_000
  const pastBreach = (mins) => conv(60 * M + mins * M)

  it('SLA sweep: at the breach an unreadable human-reply check skips the thread this tick (no push, no stamp)', async () => {
    const { db, updates } = sweepDb({ convs: [pastBreach(5)], readErrors: { whatsapp_messages: DOWN } })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    expect(stampOf(updates)).toBeUndefined()
    expect(out).toMatchObject({ escalated: 0, reply_unread: 1 })
    expect(logError).toHaveBeenCalledWith('handoff-sla', 'human-reply read failed; not escalated, retried next tick',
      expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv-1', err: 'down' }))
  })

  it('SLA sweep: the grace for an unreadable reply check is two 15-minute ticks, not the push retry window', () => {
    expect(HANDOFF_REPLY_UNREAD_GRACE_MINUTES).toBe(30)
    expect(HANDOFF_REPLY_UNREAD_GRACE_MINUTES * M).toBeLessThan(HANDOFF_ALERT_RETRY_HOURS * H)
  })

  it('SLA sweep: a reply read failing every tick escalates once the grace is spent, saying the reply could not be confirmed', async () => {
    // Handed off 60 + 5 minutes before the first tick: ticks land 5, 20, 35 and 50 minutes past the breach.
    const thread = pastBreach(5)
    const { db } = sweepDb({ convs: [thread], readErrors: { whatsapp_messages: DOWN } })
    const tick = (n) => runHandoffSlaSweep(db, { nowMs: NOW + n * 15 * M })

    expect(await tick(0)).toMatchObject({ escalated: 0, reply_unread: 1 })
    expect(await tick(1)).toMatchObject({ escalated: 0, reply_unread: 1 })
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()

    const third = await tick(2)
    expect(third).toMatchObject({ escalated: 1, reply_unread: 1 })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const [, , payload] = sendPushToRolesAtLocation.mock.calls[0]
    expect(payload.body).toMatch(/couldn't confirm whether anyone has replied/)
    expect(payload.body).not.toMatch(/nobody has replied/)
    expect(payload.body).not.toMatch(/\u2014/) // staff copy: no em-dash
    expect(logError).toHaveBeenCalledWith('handoff-sla', 'human-reply read still failing past the grace; escalating unconfirmed',
      expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv-1', err: 'down' }))
    expect(thread.handoff_escalated_at).toBe(new Date(NOW + 30 * M).toISOString())

    // One escalation per thread: the CAS stamp takes it out of the candidate read.
    expect(await tick(3)).toMatchObject({ escalated: 0, reply_unread: 0 })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })

  it('SLA sweep: an unconfirmed-reply escalation whose push fails gets the normal retry window, not one attempt then gave_up', async () => {
    const thread = pastBreach(35) // past the reply-read grace, well inside HANDOFF_ALERT_RETRY_HOURS
    const { db } = sweepDb({ convs: [thread], readErrors: { whatsapp_messages: DOWN } })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 2 })

    const first = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(first).toMatchObject({ escalated: 0, alert_failed: 1, gave_up: 0, reply_unread: 1 })
    expect(thread.handoff_escalated_at).toBeNull()
    expect(logError).not.toHaveBeenCalledWith('handoff-sla', 'escalation never reached a manager; gave up', expect.anything())

    const second = await runHandoffSlaSweep(db, { nowMs: NOW + 15 * M })
    expect(second).toMatchObject({ escalated: 1, alert_failed: 0, gave_up: 0 })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(2)
    expect(sendPushToRolesAtLocation.mock.calls[1][2].body).toMatch(/couldn't confirm whether anyone has replied/)
    expect(thread.handoff_escalated_at).toBe(new Date(NOW + 15 * M).toISOString())
  })

  it('SLA sweep: an unconfirmed-reply escalation still failing past the push retry window gives up loudly (stamped once)', async () => {
    const thread = pastBreach((HANDOFF_ALERT_RETRY_HOURS + 1) * 60)
    const { db } = sweepDb({ convs: [thread], readErrors: { whatsapp_messages: DOWN } })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, failed: 1 })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(out).toMatchObject({ escalated: 0, gave_up: 1 })
    expect(thread.handoff_escalated_at).toBe(new Date(NOW).toISOString())
    expect(logError).toHaveBeenCalledWith('handoff-sla', 'escalation never reached a manager; gave up', expect.objectContaining({ conversationId: 'conv-1' }))
  })

  it('SLA sweep: a readable reply check that finds a human reply never escalates (unchanged)', async () => {
    const thread = pastBreach(45)
    const { db, updates } = sweepDb({ convs: [thread], replies: [{ created_at: new Date(NOW - 50 * M).toISOString() }] })
    const out = await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    expect(stampOf(updates)).toBeUndefined()
    expect(out).toMatchObject({ escalated: 0, skipped: 1, reply_unread: 0 })
  })

  it('SLA sweep: a readable check with no reply keeps the normal wording', async () => {
    const { db } = sweepDb({ convs: [pastBreach(5)] })
    await runHandoffSlaSweep(db, { nowMs: NOW })
    const [, , payload] = sendPushToRolesAtLocation.mock.calls[0]
    expect(payload.body).toMatch(/nobody has replied yet/)
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
