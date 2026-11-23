// PAIDTRIALTRIGGER.1 — the €39 purchase sweep: every recent paid-trial
// purchase at a un1t.online studio is offered to the studio's active
// un1t_paid_trial_purchased sequences.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/paid-trial-products', () => ({ paidTrialProductIdsFor: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
import { paidTrialProductIdsFor } from '@/lib/paid-trial-products'
import { logError } from '@/lib/log'
import { sweepPaidTrialPurchases, PURCHASE_WINDOW_MS } from './un1t-paid-trial-purchases.js'

const LOC = 'loc-hatch'
const NOW = Date.parse('2026-11-02T12:00:00Z')
const HOUR = 3_600_000
const at = (h) => new Date(NOW - h * HOUR).toISOString()

// Records every chain; email_sequences answers a head count, un1t_transactions
// its rows filtered by the chain's eq/in/gt/gte.
function fakeDb({ activeSequences = 1, txs = [], seqError = null, txError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const st = { table, eq: {}, in: {}, gt: {}, gte: {}, not: [], order: [], range: null, cols: null, opts: null }
      const chain = {
        select(c, o) { st.cols = c; st.opts = o; return chain },
        eq(c, v) { st.eq[c] = v; return chain },
        in(c, v) { st.in[c] = v; return chain },
        gt(c, v) { st.gt[c] = v; return chain },
        gte(c, v) { st.gte[c] = v; return chain },
        not(c, op, v) { st.not.push([c, op, v]); return chain },
        order(c) { st.order.push(c); return chain },
        range(a, b) { st.range = [a, b]; return chain },
        then(res, rej) {
          calls.push(st)
          if (table === 'email_sequences') {
            return Promise.resolve(seqError ? { count: null, error: seqError } : { count: activeSequences, error: null }).then(res, rej)
          }
          if (txError) return Promise.resolve({ data: null, error: txError }).then(res, rej)
          let rows = txs.filter((r) => Object.entries(st.eq).every(([c, v]) => r[c] === v)
            && Object.entries(st.in).every(([c, v]) => v.includes(r[c]))
            && Object.entries(st.gt).every(([c, v]) => Number(r[c]) > v)
            && Object.entries(st.gte).every(([c, v]) => r[c] >= v)
            && st.not.every(([c]) => r[c] != null))
          if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1)
          return Promise.resolve({ data: rows, error: null }).then(res, rej)
        },
      }
      return chain
    },
  }
}

const tx = (over = {}) => ({ id: 'tx-1', location_id: LOC, contact_id: 'c1', product_id: 'paid-39', amount_cents: 3900, refunded: false, remote_created_at: at(1), ...over })

beforeEach(() => {
  vi.clearAllMocks()
  paidTrialProductIdsFor.mockResolvedValue(new Set(['paid-39']))
})

describe('sweepPaidTrialPurchases', () => {
  it('offers each recent paid €39 purchase to the trigger, once per buyer', async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true, enrolled: 1 })
    const db = fakeDb({ txs: [tx(), tx({ id: 'tx-2', contact_id: 'c2', remote_created_at: at(3) })] })
    const out = await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger })
    expect(out).toMatchObject({ ok: true, checked: 2, enrolled: 2, already: 0, failed: 0 })
    expect(trigger).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: LOC, transactionId: 'tx-1' })
    expect(trigger).toHaveBeenCalledWith(db, { contactId: 'c2', locationId: LOC, transactionId: 'tx-2' })
  })

  it('reads only this studio\'s paid, unrefunded, linked purchases of its paid-trial products inside the window', async () => {
    const db = fakeDb({ txs: [] })
    await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger: vi.fn() })
    const read = db.calls.find((c) => c.table === 'un1t_transactions')
    expect(read.eq).toMatchObject({ location_id: LOC, refunded: false })
    expect(read.in.product_id).toEqual(['paid-39'])
    expect(read.gt.amount_cents).toBe(0)
    expect(read.gte.remote_created_at).toBe(new Date(NOW - PURCHASE_WINDOW_MS).toISOString())
    expect(read.not).toContainEqual(['contact_id', 'is', null])
    expect(read.cols).not.toMatch(/\*/)
    expect(read.order.length).toBeGreaterThan(0)
    expect(read.range).not.toBeNull()
  })

  it('a €0 transaction on the paid-trial product (the free trial it used to be) is never a purchase', async () => {
    const trigger = vi.fn()
    const db = fakeDb({ txs: [tx({ amount_cents: 0 })] })
    const out = await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger })
    expect(out.checked).toBe(0)
    expect(trigger).not.toHaveBeenCalled()
  })

  it('a buyer already enrolled (enrolled 0) counts as already, not as a failure', async () => {
    const db = fakeDb({ txs: [tx()] })
    const out = await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger: vi.fn().mockResolvedValue({ ok: true, enrolled: 0 }) })
    expect(out).toMatchObject({ ok: true, enrolled: 0, already: 1, failed: 0 })
  })

  it('two purchases by one buyer are offered once (the newest)', async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true, enrolled: 1 })
    const db = fakeDb({ txs: [tx({ id: 'old', remote_created_at: at(30) }), tx({ id: 'new', remote_created_at: at(2) })] })
    await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger })
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger.mock.calls[0][1].transactionId).toBe('new')
  })

  it('a refused trigger is counted failed and the sweep is not ok (retried next tick inside the window)', async () => {
    const db = fakeDb({ txs: [tx()] })
    const out = await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger: vi.fn().mockResolvedValue({ ok: false, reason: 'trigger_error' }) })
    expect(out).toMatchObject({ ok: false, failed: 1 })
  })

  it('no active sequence: nothing read, clean', async () => {
    const db = fakeDb({ activeSequences: 0 })
    const out = await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger: vi.fn() })
    expect(out).toMatchObject({ ok: true, skipped_no_sequence: true, checked: 0 })
    expect(db.calls.some((c) => c.table === 'un1t_transactions')).toBe(false)
    expect(paidTrialProductIdsFor).not.toHaveBeenCalled()
  })

  it('an unreadable paid-trial set, sequence list or transaction read is not ok, never "no purchases"', async () => {
    paidTrialProductIdsFor.mockRejectedValueOnce(new Error('settings down'))
    expect((await sweepPaidTrialPurchases(fakeDb(), LOC, { nowMs: NOW, trigger: vi.fn() })).ok).toBe(false)
    expect((await sweepPaidTrialPurchases(fakeDb({ seqError: { code: 'X' } }), LOC, { nowMs: NOW, trigger: vi.fn() })).ok).toBe(false)
    expect((await sweepPaidTrialPurchases(fakeDb({ txError: { code: 'Y', message: 'boom' } }), LOC, { nowMs: NOW, trigger: vi.fn() })).ok).toBe(false)
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/boom/)
  })

  it('a studio with no paid-trial product: clean, nothing to offer', async () => {
    paidTrialProductIdsFor.mockResolvedValueOnce(new Set())
    const db = fakeDb({ txs: [tx()] })
    const out = await sweepPaidTrialPurchases(db, LOC, { nowMs: NOW, trigger: vi.fn() })
    expect(out).toMatchObject({ ok: true, checked: 0 })
    expect(db.calls.some((c) => c.table === 'un1t_transactions')).toBe(false)
  })
})
