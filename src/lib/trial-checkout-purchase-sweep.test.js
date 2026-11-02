// STILL39SEQ.1 — the checkout €39 purchase sweep: every recent paid, granted
// trial_purchases row (the CRM's own /trial checkout, which Stillorgan buyers
// pay through) is offered to the studio's active paid_trial_checkout_purchased
// sequences.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
import { logError } from '@/lib/log'
import { sweepCheckoutTrialPurchases, CHECKOUT_PURCHASE_WINDOW_MS, CHECKOUT_PURCHASE_TRIGGER } from './trial-checkout-purchase-sweep.js'

const STILL = 'loc-st'
const OTHER = 'loc-other'
const NOW = Date.parse('2026-11-03T12:00:00Z')
const HOUR = 3_600_000
const at = (h) => new Date(NOW - h * HOUR).toISOString()

// email_sequences answers its rows (location_id of each active sequence);
// trial_purchases its rows filtered by the chain's eq/in/gt/gte/not.
function fakeDb({ sequences = [{ location_id: STILL }], purchases = [], seqError = null, tpError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const st = { table, eq: {}, in: {}, gt: {}, gte: {}, not: [], order: [], range: null, cols: null }
      const chain = {
        select(c) { st.cols = c; return chain },
        eq(c, v) { st.eq[c] = v; return chain },
        in(c, v) { st.in[c] = v; return chain },
        gt(c, v) { st.gt[c] = v; return chain },
        gte(c, v) { st.gte[c] = v; return chain },
        not(c, op, v) { st.not.push([c, op, v]); return chain },
        order(c) { st.order.push(c); return chain },
        range(a, b) { st.range = [a, b]; return chain },
        then(res, rej) {
          calls.push(st)
          const pick = (rows) => rows.filter((r) => Object.entries(st.eq).every(([c, v]) => r[c] === v)
            && Object.entries(st.in).every(([c, v]) => v.includes(r[c]))
            && Object.entries(st.gt).every(([c, v]) => Number(r[c]) > v)
            && Object.entries(st.gte).every(([c, v]) => r[c] >= v)
            && st.not.every(([c]) => r[c] != null))
          if (table === 'email_sequences') {
            return Promise.resolve(seqError ? { data: null, error: seqError } : { data: sequences, error: null }).then(res, rej)
          }
          if (tpError) return Promise.resolve({ data: null, error: tpError }).then(res, rej)
          let rows = pick(purchases)
          if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1)
          return Promise.resolve({ data: rows, error: null }).then(res, rej)
        },
      }
      return chain
    },
  }
}

const tp = (over = {}) => ({
  id: 'tp-1', location_id: STILL, contact_id: 'c1', amount_cents: 3900,
  status: 'granted', payment_status: 'paid', granted_at: at(1), ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('sweepCheckoutTrialPurchases', () => {
  it('offers each recent granted purchase to the trigger, with the studio and the purchase id', async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true, enrolled: 1 })
    const db = fakeDb({ purchases: [tp(), tp({ id: 'tp-2', contact_id: 'c2', granted_at: at(5) })] })
    const out = await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger })
    expect(out).toEqual({ ok: true, locations: 1, checked: 2, enrolled: 2, already: 0, failed: 0 })
    expect(trigger).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: STILL, purchaseId: 'tp-1' })
    expect(trigger).toHaveBeenCalledWith(db, { contactId: 'c2', locationId: STILL, purchaseId: 'tp-2' })
  })

  it('looks only for active sequences of its own trigger type', async () => {
    const db = fakeDb()
    await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger: vi.fn() })
    const read = db.calls.find((c) => c.table === 'email_sequences')
    expect(read.eq).toEqual({ trigger_type: CHECKOUT_PURCHASE_TRIGGER, status: 'active' })
    expect(CHECKOUT_PURCHASE_TRIGGER).toBe('paid_trial_checkout_purchased')
  })

  it('no active sequence anywhere: reads no purchases and is clean', async () => {
    const db = fakeDb({ sequences: [] })
    const trigger = vi.fn()
    const out = await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger })
    expect(out).toEqual({ ok: true, locations: 0, checked: 0, enrolled: 0, already: 0, failed: 0 })
    expect(db.calls.some((c) => c.table === 'trial_purchases')).toBe(false)
    expect(trigger).not.toHaveBeenCalled()
  })

  it('reads only paid, granted, linked, non-zero purchases inside the window at the studios with a sequence, by named columns', async () => {
    const db = fakeDb({ sequences: [{ location_id: STILL }, { location_id: STILL }] })
    await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger: vi.fn() })
    const read = db.calls.find((c) => c.table === 'trial_purchases')
    expect(read.in.location_id).toEqual([STILL])
    expect(read.eq).toMatchObject({ payment_status: 'paid', status: 'granted' })
    expect(read.gt.amount_cents).toBe(0)
    expect(read.gte.granted_at).toBe(new Date(NOW - CHECKOUT_PURCHASE_WINDOW_MS).toISOString())
    expect(read.not).toContainEqual(['contact_id', 'is', null])
    expect(read.cols).not.toMatch(/\*/)
    expect(read.range).toEqual([0, 999])
    expect(CHECKOUT_PURCHASE_WINDOW_MS).toBe(48 * HOUR)
  })

  it('a purchase at a studio with no active sequence is never offered', async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true, enrolled: 1 })
    const db = fakeDb({ purchases: [tp({ location_id: OTHER })] })
    const out = await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger })
    expect(out.checked).toBe(0)
    expect(trigger).not.toHaveBeenCalled()
  })

  it('a buyer with two purchases is offered once, the newest, whatever order the rows came in', async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true, enrolled: 1 })
    const db = fakeDb({ purchases: [tp({ id: 'tp-old', granted_at: at(30) }), tp({ id: 'tp-new', granted_at: at(2) })] })
    const out = await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger })
    expect(out.checked).toBe(1)
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: STILL, purchaseId: 'tp-new' })
  })

  it('an already-enrolled buyer counts as already; a refused offer counts as failed and makes the run not ok', async () => {
    const trigger = vi.fn()
      .mockResolvedValueOnce({ ok: true, enrolled: 0 })
      .mockResolvedValueOnce({ ok: false, reason: 'sequences_unreadable' })
    const db = fakeDb({ purchases: [tp(), tp({ id: 'tp-2', contact_id: 'c2' })] })
    const out = await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger })
    expect(out).toMatchObject({ ok: false, checked: 2, enrolled: 0, already: 1, failed: 1 })
  })

  it('a failed sequence read or purchase read is not ok, offers nothing and logs without the error text', async () => {
    const trigger = vi.fn()
    const a = await sweepCheckoutTrialPurchases(fakeDb({ seqError: { code: 'X1', message: 'seq boom' } }), { nowMs: NOW, trigger })
    expect(a).toMatchObject({ ok: false, checked: 0 })
    const b = await sweepCheckoutTrialPurchases(fakeDb({ tpError: { code: 'X2', message: 'tp boom' } }), { nowMs: NOW, trigger })
    expect(b).toMatchObject({ ok: false, checked: 0 })
    expect(trigger).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toMatch(/boom/)
  })

  it('a trigger that throws counts as failed and the next buyer is still offered', async () => {
    const trigger = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({ ok: true, enrolled: 1 })
    const db = fakeDb({ purchases: [tp(), tp({ id: 'tp-2', contact_id: 'c2' })] })
    const out = await sweepCheckoutTrialPurchases(db, { nowMs: NOW, trigger })
    expect(out).toMatchObject({ ok: false, checked: 2, enrolled: 1, failed: 1 })
  })
})
