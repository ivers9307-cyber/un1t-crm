// TRIALABANDON.1 — the abandoned €39 checkout sweep: who is enrolled, who is
// left out and why, what is stamped, and how a purchase ends the sequence.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({ triggerSequencesForTrialCheckoutAbandoned: vi.fn() }))
vi.mock('@/lib/trial-eligibility', () => ({ stillorganTrialHistory: vi.fn(), hatchActiveMembership: vi.fn() }))
vi.mock('@/lib/paid-trial-products', () => ({ paidTrialProductIdsFor: vi.fn() }))
vi.mock('@/lib/trial-studios', () => ({
  TRIAL_STUDIOS: [{ key: 'stillorgan', publicPath: 'stillorgan' }, { key: 'hatch', publicPath: 'hatch-street' }],
}))
import { logError } from '@/lib/log'
import {
  sweepAbandonedTrialCheckouts, isAbandonedCheckout, ABANDON_WAIT_MS, ABANDON_WINDOW_MS, ABANDON_REPEAT_MS,
  MAX_CONTACTS_PER_TICK, ABANDONED_TRIGGER,
} from './trial-checkout-abandoned.js'

const STILL = 'loc-st'
const HATCH = 'loc-hatch'
const NOW = Date.parse('2026-11-14T12:00:00Z')
const HOUR = 3_600_000
const at = (h) => new Date(NOW - h * HOUR).toISOString()

// A small in-memory PostgREST: filters, order, range, and update with the
// same filters. `errors[table]` (or `errors['table:update']`) makes that
// table's reads (or writes) fail.
function fakeDb(tables, errors = {}) {
  const writes = []
  const match = (st) => (r) => st.eq.every(([c, v]) => r[c] === v)
    && st.in.every(([c, v]) => v.includes(r[c]))
    && st.gte.every(([c, v]) => r[c] >= v)
    && st.gt.every(([c, v]) => Number(r[c]) > v)
    && st.is.every(([c, v]) => (r[c] ?? null) === v)
    && st.not.every(([c]) => r[c] != null)
  return {
    writes,
    tables,
    from(table) {
      const st = { eq: [], in: [], gte: [], gt: [], is: [], not: [], range: null, patch: null, single: false }
      const chain = {
        select() { return chain },
        update(patch) { st.patch = patch; return chain },
        eq(c, v) { st.eq.push([c, v]); return chain },
        in(c, v) { st.in.push([c, v]); return chain },
        gte(c, v) { st.gte.push([c, v]); return chain },
        gt(c, v) { st.gt.push([c, v]); return chain },
        is(c, v) { st.is.push([c, v]); return chain },
        not(c) { st.not.push([c]); return chain },
        order() { return chain },
        range(a, b) { st.range = [a, b]; return chain },
        maybeSingle() { st.single = true; return chain },
        then(res, rej) {
          const err = errors[st.patch ? `${table}:update` : table]
          if (err) return Promise.resolve({ data: null, error: err }).then(res, rej)
          let rows = (tables[table] || []).filter(match(st))
          if (st.patch) {
            for (const r of rows) Object.assign(r, st.patch)
            writes.push({ table, patch: st.patch, ids: rows.map((r) => r.id) })
            return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(res, rej)
          }
          if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1)
          return Promise.resolve({ data: st.single ? (rows[0] ?? null) : rows, error: null }).then(res, rej)
        },
      }
      return chain
    },
  }
}

let n = 0
const tp = (over = {}) => ({
  id: `tp-${++n}`, location_id: STILL, contact_id: 'c1', status: 'payment_failed', payment_status: 'expired',
  last_error: 'checkout_expired', payment_provider: 'revolut', payment_checkout_token: 'tok', landing_path: 'stillorgan',
  created_at: at(3), abandon_followup_at: null, abandon_followup_outcome: null, ...over,
})
const base = (over = {}) => ({
  email_sequences: [{ id: 'seq-st', location_id: STILL, status: 'active', trigger_type: ABANDONED_TRIGGER }],
  locations: [{ id: STILL, membership_source: 'glofox' }, { id: HATCH, membership_source: 'un1t_online' }],
  contacts: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
  trial_purchases: [],
  sequence_enrollments: [],
  un1t_transactions: [],
  ...over,
})
const deps = (over = {}) => ({
  nowMs: NOW,
  trigger: vi.fn().mockResolvedValue({ ok: true, enrolled: 1 }),
  glofoxHistory: vi.fn().mockResolvedValue({ ok: true, hadTrial: false, reasons: [] }),
  un1tMembership: vi.fn().mockResolvedValue({ ok: true, active: false, reasons: [] }),
  productIdsFor: vi.fn().mockResolvedValue(new Set(['prod-39'])),
  ...over,
})

beforeEach(() => { vi.clearAllMocks(); n = 0 })

describe('isAbandonedCheckout', () => {
  it('payment_failed and expired are abandoned; failed only when the checkout never opened', () => {
    expect(isAbandonedCheckout({ status: 'payment_failed' }, NOW)).toBe(true)
    expect(isAbandonedCheckout({ status: 'expired' }, NOW)).toBe(true)
    expect(isAbandonedCheckout({ status: 'failed', last_error: 'checkout_not_opened' }, NOW)).toBe(true)
    expect(isAbandonedCheckout({ status: 'failed', last_error: 'trial_used: paid_trial_granted' }, NOW)).toBe(false)
  })
  it('awaiting_payment is abandoned only once the wait has passed', () => {
    expect(ABANDON_WAIT_MS).toBe(60 * 60_000)
    expect(isAbandonedCheckout({ status: 'awaiting_payment', created_at: new Date(NOW - ABANDON_WAIT_MS + 1000).toISOString() }, NOW)).toBe(false)
    expect(isAbandonedCheckout({ status: 'awaiting_payment', created_at: new Date(NOW - ABANDON_WAIT_MS).toISOString() }, NOW)).toBe(true)
  })
  it('rows staff hold, and paid rows, are never abandoned', () => {
    for (const status of ['help_requested', 'needs_review', 'handled', 'queued', 'processing', 'granted']) {
      expect(isAbandonedCheckout({ status, created_at: at(5) }, NOW)).toBe(false)
    }
  })
})

describe('sweepAbandonedTrialCheckouts: enrolling', () => {
  it('enrols an abandoned Stillorgan checkout and stamps the row enrolled', async () => {
    const row = tp()
    const db = fakeDb(base({ trial_purchases: [row] }))
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(out).toMatchObject({ ok: true, locations: 1, candidates: 1, checked: 1, enrolled: 1, held: 0, failed: 0 })
    expect(d.trigger).toHaveBeenCalledWith(db, {
      contactId: 'c1', locationId: STILL, purchaseId: row.id,
      checkout: { purchase_id: row.id, studio: 'stillorgan', provider: 'revolut', created_at: row.created_at, resumable: false },
    })
    expect(row.abandon_followup_outcome).toBe('enrolled')
    expect(row.abandon_followup_at).toBe(new Date(NOW).toISOString())
    expect(d.glofoxHistory).toHaveBeenCalledWith(db, { locationId: STILL, contact: { id: 'c1' } })
  })

  it('an awaiting_payment Revolut row past the wait is enrolled as resumable', async () => {
    const row = tp({ status: 'awaiting_payment', payment_status: 'pending', last_error: null, created_at: at(1.2) })
    const d = deps()
    await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row] })), d)
    expect(d.trigger.mock.calls[0][1].checkout.resumable).toBe(true)
  })

  it('HATCHTRACK.1 — a Hatch row still awaiting payment past the wait is enrolled as resumable (the page continues the same row)', async () => {
    const row = tp({ location_id: HATCH, status: 'awaiting_payment', payment_status: 'pending', last_error: null, payment_provider: 'un1t_online', payment_checkout_token: null, landing_path: 'hatch-street', created_at: at(1.2) })
    const db = fakeDb(base({
      email_sequences: [{ id: 'seq-h', location_id: HATCH, status: 'active', trigger_type: ABANDONED_TRIGGER }],
      trial_purchases: [row],
    }))
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(out).toMatchObject({ ok: true, enrolled: 1 })
    expect(d.trigger.mock.calls[0][1].checkout).toEqual({ purchase_id: row.id, studio: 'hatch', provider: 'un1t_online', created_at: row.created_at, resumable: true })
    // One row, judged once: a later tick (the buyer has since been back to
    // pay it, twice; the row is the same row) offers nothing again.
    const again = deps()
    await sweepAbandonedTrialCheckouts(db, again)
    expect(again.trigger).not.toHaveBeenCalled()
    expect(row.status).toBe('awaiting_payment')
  })

  it('an EXPIRED Hatch row is judged on the un1t.online reads and is not resumable', async () => {
    const row = tp({ location_id: HATCH, status: 'expired', payment_status: null, last_error: null, payment_provider: 'un1t_online', payment_checkout_token: null, landing_path: 'hatch-street' })
    const db = fakeDb(base({
      email_sequences: [{ id: 'seq-h', location_id: HATCH, status: 'active', trigger_type: ABANDONED_TRIGGER }],
      trial_purchases: [row],
    }))
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(out).toMatchObject({ ok: true, enrolled: 1 })
    expect(d.un1tMembership).toHaveBeenCalledWith(db, { locationId: HATCH, contactId: 'c1' })
    expect(d.glofoxHistory).not.toHaveBeenCalled()
    expect(d.trigger.mock.calls[0][1].checkout).toMatchObject({ studio: 'hatch', provider: 'un1t_online', resumable: false })
  })

  it('takes one person\'s rows together: one offer, on the newest, and every row stamped', async () => {
    const older = tp({ created_at: at(20) })
    const newer = tp({ created_at: at(2) })
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [older, newer] })), d)
    expect(d.trigger).toHaveBeenCalledTimes(1)
    expect(d.trigger.mock.calls[0][1].purchaseId).toBe(newer.id)
    expect([older.abandon_followup_outcome, newer.abandon_followup_outcome]).toEqual(['enrolled', 'enrolled'])
    expect(out).toMatchObject({ candidates: 2, checked: 1 })
  })

  it('an offer nobody took (audience, already enrolled) is stamped not_enrolled', async () => {
    const row = tp()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row] })), deps({ trigger: vi.fn().mockResolvedValue({ ok: true, enrolled: 0 }) }))
    expect(row.abandon_followup_outcome).toBe('not_enrolled')
    expect(out).toMatchObject({ ok: true, enrolled: 0, not_enrolled: 1 })
  })
})

describe('sweepAbandonedTrialCheckouts: who is left out', () => {
  it('a studio with no active sequence: stamped no_active_sequence, no eligibility read, no offer', async () => {
    const row = tp({ location_id: HATCH })
    const paused = tp({ contact_id: 'c2' })
    const db = fakeDb(base({
      email_sequences: [{ id: 'seq-st', location_id: STILL, status: 'paused', trigger_type: ABANDONED_TRIGGER }],
      trial_purchases: [row, paused],
    }))
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(out).toMatchObject({ ok: true, locations: 0, no_sequence: 2, checked: 0 })
    expect(d.trigger).not.toHaveBeenCalled()
    expect(d.glofoxHistory).not.toHaveBeenCalled()
    expect(row.abandon_followup_outcome).toBe('no_active_sequence')
    expect(paused.abandon_followup_outcome).toBe('no_active_sequence')
  })

  it('rows older than 72 hours, and rows already stamped, are never candidates', async () => {
    const old = tp({ created_at: new Date(NOW - ABANDON_WINDOW_MS - 1000).toISOString() })
    const done = tp({ contact_id: 'c2', abandon_followup_at: at(1), abandon_followup_outcome: 'no_active_sequence' })
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [old, done] })), d)
    expect(out).toMatchObject({ ok: true, candidates: 0 })
    expect(d.trigger).not.toHaveBeenCalled()
    expect(old.abandon_followup_at).toBeNull()
  })

  it.each([
    ['granted', { status: 'granted', payment_status: 'paid' }],
    ['queued', { status: 'queued', payment_status: 'paid' }],
    ['processing', { status: 'processing', payment_status: 'paid' }],
    ['paid, stopped for review', { status: 'needs_review', payment_status: 'paid' }],
  ])('a purchase at or after the abandoned row (%s) is stamped purchased, never offered', async (_n, over) => {
    const row = tp({ created_at: at(5) })
    const bought = tp({ created_at: at(4), ...over })
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row, bought] })), d)
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_outcome).toBe('purchased')
    expect(bought.abandon_followup_at).toBeNull()
    expect(out).toMatchObject({ ok: true, purchased: 1 })
  })

  it.each(['help_requested', 'handled'])('a later row staff hold (%s) is stamped staff_handling', async (status) => {
    const row = tp({ created_at: at(5) })
    const d = deps()
    await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row, tp({ created_at: at(4), status, payment_status: null })] })), d)
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_outcome).toBe('staff_handling')
  })

  it('a help_requested row on its own is never a candidate', async () => {
    const help = tp({ status: 'help_requested', payment_status: null })
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [help] })), deps())
    expect(out.candidates).toBe(0)
    expect(help.abandon_followup_at).toBeNull()
  })

  it('someone mid-checkout right now waits: nothing stamped, nothing offered', async () => {
    const row = tp({ created_at: at(5) })
    const live = tp({ status: 'awaiting_payment', payment_status: 'pending', created_at: at(0.2) })
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row, live] })), d)
    expect(out).toMatchObject({ ok: true, waiting: 1, checked: 0 })
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_at).toBeNull()
  })

  it('followed up in the last 14 days: stamped recent_followup', async () => {
    const before = tp({ created_at: at(24 * 10), abandon_followup_at: at(24 * 10 - 1), abandon_followup_outcome: 'enrolled' })
    const row = tp()
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [before, row] })), d)
    expect(ABANDON_REPEAT_MS).toBe(14 * 24 * HOUR)
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_outcome).toBe('recent_followup')
    expect(out.recent).toBe(1)
  })

  it('an earlier stamp that did not enrol does not block a later follow-up', async () => {
    const before = tp({ created_at: at(24 * 3 + 5), abandon_followup_at: at(24 * 3), abandon_followup_outcome: 'no_active_sequence' })
    const row = tp()
    const d = deps()
    await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [before, row] })), d)
    expect(d.trigger).toHaveBeenCalledTimes(1)
  })

  it('a Glofox studio buyer with a trial history is stamped had_trial', async () => {
    const row = tp()
    const d = deps({ glofoxHistory: vi.fn().mockResolvedValue({ ok: true, hadTrial: true, reasons: ['glofox_trial_claim'] }) })
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row] })), d)
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_outcome).toBe('had_trial')
    expect(out.ineligible).toBe(1)
  })

  const hatchBase = (row, extra = {}) => base({
    email_sequences: [{ id: 'seq-h', location_id: HATCH, status: 'active', trigger_type: ABANDONED_TRIGGER }],
    trial_purchases: [row], ...extra,
  })
  const hatchRow = () => tp({ location_id: HATCH, status: 'expired', payment_provider: 'un1t_online', landing_path: 'hatch-street', created_at: at(30) })

  it('a un1t.online studio active member is stamped active_member', async () => {
    const row = hatchRow()
    const d = deps({ un1tMembership: vi.fn().mockResolvedValue({ ok: true, active: true, reasons: ['un1t_subscription=active'] }) })
    await sweepAbandonedTrialCheckouts(fakeDb(hatchBase(row)), d)
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_outcome).toBe('active_member')
  })

  it('a trial bought straight on un1t.online since the checkout is stamped purchased', async () => {
    const row = hatchRow()
    const d = deps()
    const db = fakeDb(hatchBase(row, {
      un1t_transactions: [{ id: 'tx1', location_id: HATCH, contact_id: 'c1', product_id: 'prod-39', amount_cents: 3900, refunded: false, remote_created_at: at(2) }],
    }))
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_outcome).toBe('purchased')
    expect(out.purchased).toBe(1)
  })

  it('a free (€0) or refunded transaction on the product is not a purchase', async () => {
    const row = hatchRow()
    const d = deps()
    const db = fakeDb(hatchBase(row, {
      un1t_transactions: [
        { id: 'tx1', location_id: HATCH, contact_id: 'c1', product_id: 'prod-39', amount_cents: 0, refunded: false, remote_created_at: at(2) },
        { id: 'tx2', location_id: HATCH, contact_id: 'c1', product_id: 'prod-39', amount_cents: 3900, refunded: true, remote_created_at: at(2) },
      ],
    }))
    await sweepAbandonedTrialCheckouts(db, d)
    expect(d.trigger).toHaveBeenCalledTimes(1)
  })

  it('a row with no contact is stamped no_contact', async () => {
    const row = tp({ contact_id: null })
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row] })), deps())
    expect(row.abandon_followup_outcome).toBe('no_contact')
    expect(out).toMatchObject({ ok: true, candidates: 1, checked: 0 })
  })
})

describe('sweepAbandonedTrialCheckouts: unknown is never "no purchase"', () => {
  it.each([
    ['sequences', 'email_sequences'],
    ['trial purchases', 'trial_purchases'],
    ['locations', 'locations'],
  ])('unreadable %s: nobody enrolled, nothing stamped, not ok', async (_n, table) => {
    const row = tp()
    const db = fakeDb(base({ trial_purchases: [row] }), { [table]: { code: '57014' } })
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(out.ok).toBe(false)
    expect(d.trigger).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
    expect(logError).toHaveBeenCalled()
  })

  it.each([
    ['is unreadable', () => Promise.resolve({ ok: false, reason: 'glofox_trial_claims_unreadable' })],
    ['throws', () => Promise.reject(new Error('boom'))],
  ])('trial history %s: that person is held (no stamp, no offer) and the next person is still judged', async (_n, first) => {
    const held = tp({ contact_id: 'c1' })
    const fine = tp({ contact_id: 'c2' })
    const glofoxHistory = vi.fn()
      .mockImplementationOnce(first)
      .mockResolvedValue({ ok: true, hadTrial: false, reasons: [] })
    const d = deps({ glofoxHistory })
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [held, fine] })), d)
    expect(out).toMatchObject({ ok: false, held: 1, enrolled: 1 })
    expect(held.abandon_followup_at).toBeNull()
    expect(fine.abandon_followup_outcome).toBe('enrolled')
    expect(d.trigger).toHaveBeenCalledTimes(1)
  })

  it('an unreadable contact holds that person', async () => {
    const row = tp()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row] }), { contacts: { code: 'X' } }), deps())
    expect(out).toMatchObject({ ok: false, held: 1, enrolled: 0 })
    expect(row.abandon_followup_at).toBeNull()
  })

  it.each([
    ['membership unreadable', () => ({ un1tMembership: vi.fn().mockResolvedValue({ ok: false, reason: 'un1t_subscriptions_unreadable' }) }), {}],
    ['paid-trial products unreadable', () => ({ productIdsFor: vi.fn().mockRejectedValue(new Error('settings')) }), {}],
    ['un1t transactions unreadable', () => ({}), { un1t_transactions: { code: 'X' } }],
  ])('un1t.online studio, %s: held', async (_n, over, errors) => {
    const row = tp({ location_id: HATCH, status: 'expired', payment_provider: 'un1t_online', landing_path: 'hatch-street' })
    const db = fakeDb(base({
      email_sequences: [{ id: 'seq-h', location_id: HATCH, status: 'active', trigger_type: ABANDONED_TRIGGER }],
      trial_purchases: [row],
    }), errors)
    const d = deps(over())
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(out).toMatchObject({ ok: false, held: 1, enrolled: 0 })
    expect(d.trigger).not.toHaveBeenCalled()
    expect(row.abandon_followup_at).toBeNull()
  })

  it.each([
    ['refuses', () => Promise.resolve({ ok: false, reason: 'sequences_unreadable' })],
    ['throws', () => Promise.reject(new Error('boom'))],
  ])('a trigger that %s leaves the row unstamped for the next tick', async (_n, impl) => {
    const row = tp()
    const out = await sweepAbandonedTrialCheckouts(fakeDb(base({ trial_purchases: [row] })), deps({ trigger: vi.fn(impl) }))
    expect(out).toMatchObject({ ok: false, failed: 1, enrolled: 0 })
    expect(row.abandon_followup_at).toBeNull()
  })

  it('a stamp that fails is judged on its error: not ok, and the enrolment is not counted', async () => {
    const row = tp()
    const db = fakeDb(base({ trial_purchases: [row] }), { 'trial_purchases:update': { code: '40001' } })
    const out = await sweepAbandonedTrialCheckouts(db, deps())
    expect(out).toMatchObject({ ok: false, failed: 1, enrolled: 0 })
    expect(row.abandon_followup_at).toBeNull()
  })

  it('judges at most MAX_CONTACTS_PER_TICK people a tick and defers the rest unstamped', async () => {
    const rows = Array.from({ length: MAX_CONTACTS_PER_TICK + 3 }, (_, i) => tp({ contact_id: `p${i}`, created_at: at(10 - i / 100) }))
    const db = fakeDb(base({ trial_purchases: rows, contacts: rows.map((r) => ({ id: r.contact_id })) }))
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(d.trigger).toHaveBeenCalledTimes(MAX_CONTACTS_PER_TICK)
    expect(out).toMatchObject({ ok: true, checked: MAX_CONTACTS_PER_TICK, deferred: 3 })
    expect(rows.filter((r) => r.abandon_followup_at === null)).toHaveLength(3)
  })
})

describe('sweepAbandonedTrialCheckouts: stop on purchase', () => {
  const enrolment = (over = {}) => ({
    id: 'e1', sequence_id: 'seq-st', contact_id: 'c1', status: 'active', enrolled_at: at(20),
    metadata: { trial_checkout: { purchase_id: 'tp-x', created_at: at(22) } }, ...over,
  })

  it('a buyer leaves the abandoned sequence with exit_reason trial_purchased', async () => {
    const e = enrolment()
    const db = fakeDb(base({
      trial_purchases: [tp({ status: 'granted', payment_status: 'paid', created_at: at(1) })],
      sequence_enrollments: [e],
    }))
    const out = await sweepAbandonedTrialCheckouts(db, deps())
    expect(out).toMatchObject({ ok: true, exited: 1 })
    expect(e).toMatchObject({ status: 'exited', exit_reason: 'trial_purchased', next_step_at: null })
  })

  it('a paused enrolment and a paused sequence are exited too', async () => {
    const e = enrolment({ status: 'paused' })
    const db = fakeDb(base({
      email_sequences: [{ id: 'seq-st', location_id: STILL, status: 'paused', trigger_type: ABANDONED_TRIGGER }],
      trial_purchases: [tp({ status: 'queued', payment_status: 'paid', created_at: at(1) })],
      sequence_enrollments: [e],
    }))
    await sweepAbandonedTrialCheckouts(db, deps())
    expect(e.status).toBe('exited')
  })

  it('the same row paid late (after an hour) exits the enrolment made for it', async () => {
    const row = tp({ status: 'granted', payment_status: 'paid', created_at: at(1.5), abandon_followup_at: at(0.4), abandon_followup_outcome: 'enrolled' })
    const e = enrolment({ metadata: { trial_checkout: { purchase_id: row.id, created_at: row.created_at } } })
    const db = fakeDb(base({ trial_purchases: [row], sequence_enrollments: [e] }))
    await sweepAbandonedTrialCheckouts(db, deps())
    expect(e.status).toBe('exited')
  })

  it('HATCHTRACK.1 — a Hatch row paid on a later checkout attempt (the same row, settled days after it was made) exits the enrolment made for it', async () => {
    const row = tp({ location_id: HATCH, status: 'granted', payment_status: 'paid', payment_provider: 'un1t_online', payment_checkout_token: null, landing_path: 'hatch-street', created_at: at(40), abandon_followup_at: at(39), abandon_followup_outcome: 'enrolled' })
    const e = enrolment({ sequence_id: 'seq-h', metadata: { trial_checkout: { purchase_id: row.id, provider: 'un1t_online', created_at: row.created_at, resumable: true } } })
    const db = fakeDb(base({
      email_sequences: [{ id: 'seq-h', location_id: HATCH, status: 'active', trigger_type: ABANDONED_TRIGGER }],
      trial_purchases: [row], sequence_enrollments: [e],
    }))
    const out = await sweepAbandonedTrialCheckouts(db, deps())
    expect(out).toMatchObject({ ok: true, exited: 1 })
    expect(e).toMatchObject({ status: 'exited', exit_reason: 'trial_purchased' })
  })

  it('a purchase from BEFORE the checkout they were enrolled for does not exit them', async () => {
    const e = enrolment({ metadata: { trial_checkout: { created_at: at(2) } } })
    const db = fakeDb(base({
      trial_purchases: [tp({ status: 'granted', payment_status: 'paid', created_at: at(200) })],
      sequence_enrollments: [e],
    }))
    const out = await sweepAbandonedTrialCheckouts(db, deps())
    expect(out.exited).toBe(0)
    expect(e.status).toBe('active')
  })

  it('a purchase at another studio, or by someone else, exits nobody', async () => {
    const e = enrolment()
    const db = fakeDb(base({
      trial_purchases: [
        tp({ location_id: HATCH, status: 'granted', payment_status: 'paid', created_at: at(1) }),
        tp({ contact_id: 'c2', status: 'granted', payment_status: 'paid', created_at: at(1) }),
      ],
      sequence_enrollments: [e],
    }))
    await sweepAbandonedTrialCheckouts(db, deps())
    expect(e.status).toBe('active')
  })

  it('a completed enrolment, and one in another sequence, are left alone', async () => {
    const done = enrolment({ id: 'e2', status: 'completed' })
    const other = enrolment({ id: 'e3', sequence_id: 'seq-welcome' })
    const db = fakeDb(base({
      trial_purchases: [tp({ status: 'granted', payment_status: 'paid', created_at: at(1) })],
      sequence_enrollments: [done, other],
    }))
    await sweepAbandonedTrialCheckouts(db, deps())
    expect(done.status).toBe('completed')
    expect(other.status).toBe('active')
  })

  it('a trial bought on un1t.online exits a Hatch enrolment', async () => {
    const e = enrolment({ sequence_id: 'seq-h' })
    const db = fakeDb(base({
      email_sequences: [{ id: 'seq-h', location_id: HATCH, status: 'active', trigger_type: ABANDONED_TRIGGER }],
      sequence_enrollments: [e],
      un1t_transactions: [{ id: 'tx1', location_id: HATCH, contact_id: 'c1', product_id: 'prod-39', amount_cents: 3900, refunded: false, remote_created_at: at(1) }],
    }))
    const out = await sweepAbandonedTrialCheckouts(db, deps())
    expect(out).toMatchObject({ ok: true, exited: 1 })
    expect(e.status).toBe('exited')
  })

  it('an exit write that fails is not ok, and the enrol pass still runs', async () => {
    const e = enrolment()
    const row = tp({ contact_id: 'c2' })
    const db = fakeDb(base({
      trial_purchases: [tp({ status: 'granted', payment_status: 'paid', created_at: at(1) }), row],
      sequence_enrollments: [e],
    }), { 'sequence_enrollments:update': { code: 'X' } })
    const d = deps()
    const out = await sweepAbandonedTrialCheckouts(db, d)
    expect(out).toMatchObject({ ok: false, exited: 0, enrolled: 1 })
    expect(e.status).toBe('active')
    expect(row.abandon_followup_outcome).toBe('enrolled')
  })

  it('unreadable live enrolments: not ok, nobody exited', async () => {
    const e = enrolment()
    const db = fakeDb(base({
      trial_purchases: [tp({ status: 'granted', payment_status: 'paid', created_at: at(1) })],
      sequence_enrollments: [e],
    }), { sequence_enrollments: { code: 'X' } })
    const out = await sweepAbandonedTrialCheckouts(db, deps())
    expect(out.ok).toBe(false)
    expect(e.status).toBe('active')
  })
})
