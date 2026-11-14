// TRIALABANDON.1 — the resume link, the purchase rule, the exit and the
// pre-send check behind the abandoned €39 checkout follow-up.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
import { logWarn } from '@/lib/log'
import { TRIAL_CHECKOUT_REUSE_MS } from '@/lib/trial-checkout-window'
import {
  ABANDONED_TRIGGER, PURCHASED_EXIT_REASON, PURCHASE_ROW_FILTER, isPurchaseRow, trialCheckoutFromEnrollment,
  trialResumeLink, exitEnrolmentForPurchase, trialAbandonPresendGate,
} from './trial-abandoned-purchase.js'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const PURCHASE = '11111111-2222-3333-4444-555555555555'
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString()

beforeEach(() => { vi.clearAllMocks() })

describe('isPurchaseRow', () => {
  it('paid money, or a row on its way to the grant, is a purchase', () => {
    expect(isPurchaseRow({ status: 'granted', payment_status: 'paid' })).toBe(true)
    expect(isPurchaseRow({ status: 'needs_review', payment_status: 'paid' })).toBe(true)
    expect(isPurchaseRow({ status: 'queued' })).toBe(true)
    expect(isPurchaseRow({ status: 'processing' })).toBe(true)
  })
  it('an unpaid, failed, expired or help row is not', () => {
    for (const row of [
      { status: 'awaiting_payment', payment_status: 'pending' }, { status: 'payment_failed', payment_status: 'failed' },
      { status: 'expired' }, { status: 'help_requested' }, { status: 'handled' }, { status: 'failed' }, null,
    ]) expect(isPurchaseRow(row)).toBe(false)
  })
  it('the PostgREST filter states the same rule', () => {
    expect(PURCHASE_ROW_FILTER).toBe('payment_status.eq.paid,status.in.(queued,processing,granted)')
  })
})

describe('trialResumeLink', () => {
  const base = { baseUrl: 'https://un1tdublin.com', medium: 'email', nowMs: NOW }
  const open = { purchase_id: PURCHASE, studio: 'stillorgan', provider: 'revolut', created_at: minsAgo(70), resumable: true }

  it('an open Revolut checkout still inside its window carries the purchase', () => {
    expect(trialResumeLink({ ...base, checkout: open })).toEqual({
      url: `https://un1tdublin.com/trial?studio=stillorgan&purchase=${PURCHASE}&utm_source=crm&utm_medium=email&utm_campaign=trial-abandoned`,
      suffix: `studio=stillorgan&purchase=${PURCHASE}&utm_source=crm&utm_medium=email&utm_campaign=trial-abandoned`,
    })
  })

  it('past the reuse window the purchase is dropped: the studio alone', () => {
    const created = new Date(NOW - TRIAL_CHECKOUT_REUSE_MS).toISOString()
    expect(trialResumeLink({ ...base, checkout: { ...open, created_at: created } }).url)
      .toBe('https://un1tdublin.com/trial?studio=stillorgan&utm_source=crm&utm_medium=email&utm_campaign=trial-abandoned')
  })

  it('a row that was already closed at enrolment never carries the purchase', () => {
    expect(trialResumeLink({ ...base, checkout: { ...open, resumable: false } }).url).not.toMatch(/purchase=/)
  })

  it('a Hatch Street row (un1t.online checkout, URL never stored) never carries the purchase', () => {
    const link = trialResumeLink({ ...base, medium: 'whatsapp', checkout: { ...open, studio: 'hatch', provider: 'un1t_online' } })
    expect(link.url).toBe('https://un1tdublin.com/trial?studio=hatch&utm_source=crm&utm_medium=whatsapp&utm_campaign=trial-abandoned')
    expect(link.suffix).toBe('studio=hatch&utm_source=crm&utm_medium=whatsapp&utm_campaign=trial-abandoned')
  })

  it('an unknown studio is left off, and a malformed purchase id is never placed in the link', () => {
    expect(trialResumeLink({ ...base, checkout: { ...open, studio: null } }).url).toMatch(/\/trial\?purchase=/)
    expect(trialResumeLink({ ...base, checkout: { ...open, studio: 'a b&c' } }).url).not.toMatch(/studio=/)
    expect(trialResumeLink({ ...base, checkout: { ...open, purchase_id: 'x&y=1' } }).url).not.toMatch(/purchase=/)
  })

  it('no checkout on the run (any other trigger) renders nothing', () => {
    expect(trialResumeLink({ ...base, checkout: null })).toEqual({ url: '', suffix: '' })
    expect(trialResumeLink({ ...base, checkout: trialCheckoutFromEnrollment({ metadata: { payment: {} } }) })).toEqual({ url: '', suffix: '' })
  })

  it('a trailing slash on the base URL does not double up', () => {
    expect(trialResumeLink({ ...base, baseUrl: 'https://x.test/', checkout: { ...open, resumable: false } }).url).toMatch(/^https:\/\/x\.test\/trial\?/)
  })
})

// One table at a time: the gate reads trial_purchases, the exit updates
// sequence_enrollments.
function fakeDb({ purchases = [], readError = null, updateError = null, updated = [{ id: 'e1' }] } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const st = { table, ops: [], patch: null }
      const chain = {}
      for (const op of ['select', 'eq', 'in', 'or', 'gte', 'limit']) chain[op] = (...a) => { st.ops.push([op, ...a]); return chain }
      chain.update = (patch) => { st.patch = patch; return chain }
      chain.then = (res, rej) => {
        calls.push(st)
        if (st.patch) return Promise.resolve(updateError ? { data: null, error: updateError } : { data: updated, error: null }).then(res, rej)
        return Promise.resolve(readError ? { data: null, error: readError } : { data: purchases, error: null }).then(res, rej)
      }
      return chain
    },
  }
}

describe('exitEnrolmentForPurchase', () => {
  it('exits an active or paused enrolment with the purchased reason and unschedules it', async () => {
    const db = fakeDb()
    expect(await exitEnrolmentForPurchase(db, 'e1', NOW)).toEqual({ ok: true, exited: true })
    const call = db.calls[0]
    expect(call.table).toBe('sequence_enrollments')
    expect(call.patch).toEqual({ status: 'exited', exit_reason: PURCHASED_EXIT_REASON, next_step_at: null, last_processed_at: new Date(NOW).toISOString() })
    expect(call.ops).toContainEqual(['eq', 'id', 'e1'])
    expect(call.ops).toContainEqual(['in', 'status', ['active', 'paused']])
  })
  it('an enrolment that already finished is not an error', async () => {
    expect(await exitEnrolmentForPurchase(fakeDb({ updated: [] }), 'e1', NOW)).toEqual({ ok: true, exited: false })
  })
  it('a failed write is reported, never thrown', async () => {
    expect(await exitEnrolmentForPurchase(fakeDb({ updateError: { code: 'X' } }), 'e1', NOW)).toEqual({ ok: false, exited: false })
  })
})

describe('trialAbandonPresendGate', () => {
  const ctx = (over = {}) => ({
    enrollment: { id: 'e1', source_type: ABANDONED_TRIGGER, metadata: { trial_checkout: { created_at: minsAgo(300) } } },
    contact: { id: 'c1' }, sequence: { location_id: 'loc-st' }, ...over,
  })

  it('does nothing, and reads nothing, for an enrolment of any other trigger', async () => {
    const db = fakeDb({ purchases: [{ id: 'tp' }] })
    expect(await trialAbandonPresendGate(db, ctx({ enrollment: { id: 'e1', source_type: 'paid_trial_checkout_purchased' } }))).toEqual({ proceed: true })
    expect(db.calls).toEqual([])
  })

  it('no purchase since the checkout: proceed', async () => {
    const db = fakeDb()
    expect(await trialAbandonPresendGate(db, ctx())).toEqual({ proceed: true })
    const read = db.calls[0]
    expect(read.table).toBe('trial_purchases')
    expect(read.ops).toContainEqual(['eq', 'location_id', 'loc-st'])
    expect(read.ops).toContainEqual(['eq', 'contact_id', 'c1'])
    expect(read.ops).toContainEqual(['or', PURCHASE_ROW_FILTER])
    expect(read.ops).toContainEqual(['gte', 'created_at', minsAgo(300)])
  })

  it('a purchase since the checkout: the enrolment is exited and the step is stopped', async () => {
    const db = fakeDb({ purchases: [{ id: 'tp' }] })
    expect(await trialAbandonPresendGate(db, ctx())).toEqual({ proceed: false, reason: 'bought the trial since the checkout' })
    expect(db.calls[1].patch).toMatchObject({ status: 'exited', exit_reason: PURCHASED_EXIT_REASON })
  })

  it('fails open: an unreadable purchase read sends anyway and is logged', async () => {
    expect(await trialAbandonPresendGate(fakeDb({ readError: { code: 'X' } }), ctx())).toEqual({ proceed: true })
    expect(logWarn).toHaveBeenCalled()
  })

  it('an exit that could not be written never reports a stop (no skip-one-send-the-next)', async () => {
    const db = fakeDb({ purchases: [{ id: 'tp' }], updateError: { code: 'X' } })
    expect(await trialAbandonPresendGate(db, ctx())).toEqual({ proceed: true })
  })

  it('never throws', async () => {
    const db = { from() { throw new Error('boom') } }
    expect(await trialAbandonPresendGate(db, ctx())).toEqual({ proceed: true })
  })
})
