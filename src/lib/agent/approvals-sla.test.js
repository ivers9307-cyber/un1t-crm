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
// MIA-EXPIRY-QUIET.1 — the sweep no longer imports notify at all. The mock
// stays so 'never messages the member' has a spy that would catch a
// re-introduced customer send.
vi.mock('./notify', () => ({
  sendAgentThreadMessage: vi.fn(async () => ({ sent: true })),
}))

import { classifyApprovalAging, runApprovalsSlaSweep, APPROVAL_ESCALATE_AFTER_HOURS } from './approvals-sla'
import { sendPushToRolesAtLocation } from '@/lib/push'
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
  function sweepDb({ rows, claimMatches = true }) {
    const updates = []
    const db = {
      from(table) {
        const state = {}
        const b = {
          select: () => b,
          update(patch) { state.patch = patch; updates.push({ table, patch }); return b },
          eq: (col, val) => { if (col === 'status' && state.patch) state.claimed = claimMatches; return b },
          is: () => b, not: () => b, in: () => b, lt: () => b,
          order: () => b, limit: () => b,
          maybeSingle: async () => ({ data: state.patch && state.claimed ? { id: 'r1' } : null, error: null }),
          then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
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
})
