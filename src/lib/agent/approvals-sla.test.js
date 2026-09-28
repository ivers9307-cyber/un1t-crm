// MIA-BOARD.2 — the approvals clock. The queue had no aging and no expiry:
// a member's cancellation sat pending 13 days, and on 23 Aug two funnel
// bookings were approved at 8:26pm for classes that ran that MORNING — the
// executor booked them into Glofox anyway and sent confirmations (the Ciaran
// incident). Two behaviours, one sweep:
//   escalate — any pending row older than 24h re-alerts managers, once
//   expire   — a pending class_booking whose class has started flips to
//              'expired' and alerts STAFF ONLY
// Cancellations and pauses NEVER expire — stale intent is still intent.
//
// MIA-EXPIRY-QUIET.1 (Richard, 2026-08-31) — a missed approval must never
// message the member. An automated apology for a class we let slip lands as
// a second failure; the team is told instead and follows up as a human.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => ({ sent: 1 })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
// MIA-EXPIRY-QUIET.1 — the sweep no longer imports notify at all. The mock
// stays so 'never messages the member' has a spy that would catch a
// re-introduced customer send.
vi.mock('./notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
}))

import { classifyApprovalAging, runApprovalsSlaSweep, APPROVAL_ESCALATE_AFTER_HOURS, SLA_ALERT_RETRY_HOURS } from './approvals-sla'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { logWarn, logError } from '@/lib/log'
import { sendAgentThreadMessage } from './notify'

const H = 3_600_000
const NOW = Date.parse('2026-08-25T12:00:00Z')

describe('classifyApprovalAging', () => {
  const pendingBooking = {
    kind: 'class_booking',
    status: 'pending',
    createdAtMs: NOW - 2 * H,
    slaEscalatedAt: null,
    startsAtMs: NOW + 6 * H,
    nowMs: NOW,
  }

  it('expires a pending booking whose class has started', () => {
    expect(classifyApprovalAging({ ...pendingBooking, startsAtMs: NOW - 1 * H })).toBe('expire')
  })

  it('a booking with no machine-readable start time can only escalate', () => {
    expect(classifyApprovalAging({ ...pendingBooking, startsAtMs: null, createdAtMs: NOW - 30 * H })).toBe('escalate')
    expect(classifyApprovalAging({ ...pendingBooking, startsAtMs: null })).toBe(null)
  })

  it('escalates any pending row older than the window, once', () => {
    expect(classifyApprovalAging({ ...pendingBooking, createdAtMs: NOW - 25 * H })).toBe('escalate')
    expect(classifyApprovalAging({ ...pendingBooking, createdAtMs: NOW - 25 * H, slaEscalatedAt: '2026-08-24T13:00:00Z' })).toBe(null)
  })

  it('a cancellation never expires, even long past, but does escalate', () => {
    const cancel = { kind: 'cancellation', status: 'pending', createdAtMs: NOW - 300 * H, slaEscalatedAt: null, startsAtMs: null, nowMs: NOW }
    expect(classifyApprovalAging(cancel)).toBe('escalate')
  })

  it('expire wins over escalate when both apply', () => {
    expect(classifyApprovalAging({ ...pendingBooking, createdAtMs: NOW - 30 * H, startsAtMs: NOW - 1 * H })).toBe('expire')
  })

  it('non-pending rows are never touched', () => {
    expect(classifyApprovalAging({ ...pendingBooking, status: 'failed', startsAtMs: NOW - 1 * H })).toBe(null)
  })
})

describe('runApprovalsSlaSweep', () => {
  // C21 PUSHDONE.1 — the fake tells the owed-notice read (status=expired)
  // from the pending read, and can fail a write. `updates` records every
  // UPDATE with its filters, in order.
  function sweepDb({ rows, claimMatches = true, owed = [], updateError = null, owedError = null }) {
    const updates = []
    const db = {
      from(table) {
        const state = { eqs: {}, is: {} }
        const b = {
          select: () => b,
          update(patch) { state.patch = patch; updates.push({ table, patch, eqs: state.eqs, is: state.is }); return b },
          eq: (col, val) => { state.eqs[col] = val; if (col === 'status' && state.patch) state.claimed = claimMatches; return b },
          is: (col, val) => { state.is[col] = val; return b },
          not: () => b, in: () => b, lt: () => b,
          order: () => b, limit: () => b,
          maybeSingle: async () => ({ data: state.patch && state.claimed ? { id: 'r1' } : null, error: null }),
          then: (res, rej) => {
            let out
            if (state.patch) out = { data: null, error: updateError }
            else if (state.eqs.status === 'expired') out = owedError ? { data: null, error: owedError } : { data: owed, error: null }
            else out = { data: rows, error: null }
            return Promise.resolve(out).then(res, rej)
          },
        }
        return b
      },
    }
    return { db, updates }
  }

  const expiredRow = {
    id: 'r1',
    location_id: 'L1',
    kind: 'class_booking',
    status: 'pending',
    channel: 'whatsapp',
    conversation_id: 'conv1',
    created_at: new Date(NOW - 20 * H).toISOString(),
    sla_escalated_at: null,
    details: { class_name: 'FURY - HYBRID', class_time: 'Sun, 23 Aug, 09:00', starts_at: new Date(NOW - 4 * H).toISOString(), source: 'start_funnel' },
  }

  beforeEach(() => vi.clearAllMocks())

  it('expires a past-start booking: atomic claim and a staff push', async () => {
    const { db, updates } = sweepDb({ rows: [expiredRow] })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(out.expired).toBe(1)
    const claim = updates.find(u => u.patch?.status === 'expired')
    expect(claim).toBeTruthy()
    expect(claim.patch.details.result).toMatchObject({ ok: false, reason: 'CLASS_ALREADY_STARTED' })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })

  // MIA-EXPIRY-QUIET.1 — the member hears nothing, even with a live thread.
  it('never messages the member, even when the thread is open', async () => {
    const { db } = sweepDb({ rows: [expiredRow] })
    await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
  })

  it('tells staff the member has not been contacted', async () => {
    const { db } = sweepDb({ rows: [expiredRow] })
    await runApprovalsSlaSweep(db, { nowMs: NOW })
    const [, , payload] = sendPushToRolesAtLocation.mock.calls[0]
    expect(payload.body).toMatch(/not been messaged/i)
    expect(payload.body).not.toMatch(/has been told/i)
  })

  it('a lost claim race sends nothing', async () => {
    const { db } = sweepDb({ rows: [expiredRow], claimMatches: false })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(out.expired).toBe(0)
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('a funnel row with no conversation still expires and still alerts staff', async () => {
    const { db } = sweepDb({ rows: [{ ...expiredRow, conversation_id: null }] })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(out.expired).toBe(1)
    expect(sendAgentThreadMessage).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })

  it('escalates an old pending cancellation with a push and a stamp, never expiring it', async () => {
    const cancelRow = {
      ...expiredRow,
      kind: 'cancellation',
      details: { reason: 'moving away' },
      created_at: new Date(NOW - (APPROVAL_ESCALATE_AFTER_HOURS + 2) * H).toISOString(),
    }
    const { db, updates } = sweepDb({ rows: [cancelRow] })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(out.escalated).toBe(1)
    expect(out.expired).toBe(0)
    expect(updates.some(u => u.patch?.sla_escalated_at)).toBe(true)
    expect(updates.some(u => u.patch?.status === 'expired')).toBe(false)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })

  // ── C21 PUSHDONE.1 — "done" is recorded after the push, never before ──
  const escalateRow = {
    ...expiredRow,
    kind: 'cancellation',
    details: { reason: 'moving away' },
    created_at: new Date(NOW - (APPROVAL_ESCALATE_AFTER_HOURS + 2) * H).toISOString(),
  }
  const stampOf = (updates) => updates.find(u => u.patch?.sla_escalated_at)

  it('escalate: the push goes out BEFORE the stamp, and the stamp is a CAS on the null value', async () => {
    const { db, updates } = sweepDb({ rows: [escalateRow] })
    let stampedBeforeSend = null
    sendPushToRolesAtLocation.mockImplementationOnce(async () => { stampedBeforeSend = !!stampOf(updates); return { sent: 1 } })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(stampedBeforeSend).toBe(false)
    expect(stampOf(updates).is).toEqual({ sla_escalated_at: null })
    expect(out.escalated).toBe(1)
  })

  it('escalate: a push that reached nobody because it FAILED is not stamped, so the next tick retries', async () => {
    const { db, updates } = sweepDb({ rows: [escalateRow] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 0, invalidated: 0, failed: 2 })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeUndefined()
    expect(out).toMatchObject({ escalated: 0, notice_failed: 1 })
    expect(logWarn).toHaveBeenCalledWith('approvals-sla', 'escalation reached nobody; not stamped, retried next tick',
      expect.objectContaining({ id: 'r1' }))
  })

  it('escalate: a throw is a failure too (not stamped)', async () => {
    const { db, updates } = sweepDb({ rows: [escalateRow] })
    sendPushToRolesAtLocation.mockRejectedValueOnce(new Error('expo down'))
    await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeUndefined()
  })

  it('escalate: nobody to tell (sent 0, failed 0) is settled and stamped, never retried', async () => {
    const { db, updates } = sweepDb({ rows: [escalateRow] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 3, invalidated: 0, failed: 0 })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeTruthy()
    expect(out.escalated).toBe(1)
  })

  it('escalate: past the retry window a failing row is stamped anyway, at error level', async () => {
    const old = { ...escalateRow, created_at: new Date(NOW - (APPROVAL_ESCALATE_AFTER_HOURS + SLA_ALERT_RETRY_HOURS + 1) * H).toISOString() }
    const { db, updates } = sweepDb({ rows: [old] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, failed: 1, read_failed: 1 })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(stampOf(updates)).toBeTruthy()
    expect(out).toMatchObject({ escalated: 0, gave_up: 1 })
    expect(logError).toHaveBeenCalledWith('approvals-sla', 'escalation never reached a manager; gave up', expect.objectContaining({ id: 'r1' }))
  })

  it('escalate: a failed stamp is said at error level (managers may hear it twice; never lost)', async () => {
    const { db } = sweepDb({ rows: [escalateRow], updateError: { message: 'down' } })
    await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(logError).toHaveBeenCalledWith('approvals-sla', 'escalation stamp failed; managers may be alerted again next tick',
      expect.objectContaining({ id: 'r1', err: 'down' }))
  })

  it('expire: the claim itself carries the lease (expire_notice owed), settled to sent after a delivered push', async () => {
    const { db, updates } = sweepDb({ rows: [expiredRow] })
    await runApprovalsSlaSweep(db, { nowMs: NOW })
    const claim = updates.find(u => u.patch?.status === 'expired')
    expect(claim.patch.details.expire_notice).toBe('owed')
    const settle = updates.find(u => u.patch?.details?.expire_notice === 'sent')
    expect(settle).toBeTruthy()
    expect(settle.eqs).toMatchObject({ id: 'r1', status: 'expired' })
  })

  it('expire: a push that reached nobody leaves the notice owed (the row still expires)', async () => {
    const { db, updates } = sweepDb({ rows: [expiredRow] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, failed: 3 })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(out).toMatchObject({ expired: 1, notice_failed: 1 })
    expect(updates.some(u => ['sent', 'settled'].includes(u.patch?.details?.expire_notice))).toBe(false)
  })

  it('expire: nobody to tell settles the notice (not retried)', async () => {
    const { db, updates } = sweepDb({ rows: [expiredRow] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, skipped: 2, failed: 0 })
    await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(updates.some(u => u.patch?.details?.expire_notice === 'settled')).toBe(true)
  })

  const owedRow = {
    id: 'r9', location_id: 'L1', kind: 'class_booking',
    details: { class_name: 'FURY', class_time: 'Sun 09:00', expired_at: new Date(NOW - 2 * H).toISOString(), expire_notice: 'owed' },
  }

  it('owed pass: a notice still owed from an earlier tick is re-sent and settled', async () => {
    const { db, updates } = sweepDb({ rows: [], owed: [owedRow] })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    expect(sendPushToRolesAtLocation.mock.calls[0][2].data).toEqual({ type: 'agent_request_expired', request_id: 'r9' })
    const settle = updates.find(u => u.patch?.details?.expire_notice === 'sent')
    expect(settle.eqs).toMatchObject({ id: 'r9', status: 'expired' })
    expect(settle.patch.details.class_name).toBe('FURY')
    expect(out.notices_retried).toBe(1)
  })

  it('owed pass: still failing → stays owed', async () => {
    const { db, updates } = sweepDb({ rows: [], owed: [owedRow] })
    sendPushToRolesAtLocation.mockResolvedValueOnce({ sent: 0, failed: 1 })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(updates).toEqual([])
    expect(out.notice_failed).toBe(1)
  })

  it('owed pass: past the retry window it gives up at error level, without sending', async () => {
    const stale = { ...owedRow, details: { ...owedRow.details, expired_at: new Date(NOW - (SLA_ALERT_RETRY_HOURS + 1) * H).toISOString() } }
    const { db, updates } = sweepDb({ rows: [], owed: [stale] })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
    expect(updates[0].patch.details.expire_notice).toBe('gave_up')
    expect(out.gave_up).toBe(1)
    expect(logError).toHaveBeenCalledWith('approvals-sla', 'expiry notice never reached a manager; gave up', expect.objectContaining({ id: 'r9' }))
  })

  it('owed pass: an unreadable owed list is logged and the pending sweep still runs', async () => {
    const { db } = sweepDb({ rows: [escalateRow], owedError: { message: 'down' } })
    const out = await runApprovalsSlaSweep(db, { nowMs: NOW })
    expect(logError).toHaveBeenCalledWith('approvals-sla', 'owed expiry notices read failed; retried next tick', { err: 'down' })
    expect(out.escalated).toBe(1)
  })
})
