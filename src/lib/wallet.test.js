import { describe, it, expect } from 'vitest'
import {
  currentPeriodStart,
  nextPeriodStart,
  shouldReset,
  applyWalletEntry,
  getWallet,
} from './wallet.js'

describe('currentPeriodStart', () => {
  it('returns the first of the containing month', () => {
    expect(currentPeriodStart('2026-07-19')).toBe('2026-07-01')
    expect(currentPeriodStart('2026-07-01')).toBe('2026-07-01')
    expect(currentPeriodStart('2026-12-31')).toBe('2026-12-01')
  })

  it('rejects a non-YYYY-MM-DD input', () => {
    expect(() => currentPeriodStart('19/07/2026')).toThrow(/YYYY-MM-DD/)
    expect(() => currentPeriodStart(null)).toThrow(/YYYY-MM-DD/)
    expect(() => currentPeriodStart('2026-07-19T00:00:00Z')).toThrow(/YYYY-MM-DD/)
  })
})

describe('nextPeriodStart', () => {
  it('returns the first of the following month', () => {
    expect(nextPeriodStart('2026-07-19')).toBe('2026-08-01')
    expect(nextPeriodStart('2026-07-01')).toBe('2026-08-01')
    expect(nextPeriodStart('2026-07-31')).toBe('2026-08-01')
  })

  it('rolls December into January of the next year', () => {
    expect(nextPeriodStart('2026-12-15')).toBe('2027-01-01')
    expect(nextPeriodStart('2026-12-01')).toBe('2027-01-01')
  })

  it('handles February (incl. leap year) as plain calendar months', () => {
    expect(nextPeriodStart('2028-02-29')).toBe('2028-03-01')
    expect(nextPeriodStart('2026-01-31')).toBe('2026-02-01')
  })

  it('rejects a non-YYYY-MM-DD input', () => {
    expect(() => nextPeriodStart('2026-7-1')).toThrow(/YYYY-MM-DD/)
  })
})

describe('shouldReset', () => {
  it('is true when period_start is missing (never initialised)', () => {
    expect(shouldReset({ period_start: null }, '2026-07-19')).toBe(true)
    expect(shouldReset({}, '2026-07-19')).toBe(true)
  })

  it('is true when period_start is in an earlier month (boundary crossed)', () => {
    expect(shouldReset({ period_start: '2026-06-01' }, '2026-07-19')).toBe(true)
    expect(shouldReset({ period_start: '2026-06-01' }, '2026-07-01')).toBe(true)
    // Multiple missed months still answer true — self-healing.
    expect(shouldReset({ period_start: '2026-03-01' }, '2026-07-02')).toBe(true)
    // Year boundary.
    expect(shouldReset({ period_start: '2026-12-01' }, '2027-01-01')).toBe(true)
  })

  it('is false when period_start is already this period (same-day rerun no-op)', () => {
    expect(shouldReset({ period_start: '2026-07-01' }, '2026-07-19')).toBe(false)
    expect(shouldReset({ period_start: '2026-07-01' }, '2026-07-01')).toBe(false)
    expect(shouldReset({ period_start: '2026-07-01' }, '2026-07-31')).toBe(false)
  })

  it('is false when period_start is (anomalously) in the future', () => {
    expect(shouldReset({ period_start: '2026-08-01' }, '2026-07-19')).toBe(false)
  })

  it('is false for a missing wallet', () => {
    expect(shouldReset(null, '2026-07-19')).toBe(false)
    expect(shouldReset(undefined, '2026-07-19')).toBe(false)
  })
})

// Mock db: records rpc() calls; from() supports select-eq-maybeSingle.
function mockDb({ rpcResult = { data: 0, error: null }, walletRow = null, selectError = null } = {}) {
  const rpcCalls = []
  const db = {
    rpc(name, args) {
      rpcCalls.push({ name, args })
      return Promise.resolve(rpcResult)
    },
    from(table) {
      const chain = {
        select() { return chain },
        eq() { return chain },
        maybeSingle() {
          return Promise.resolve({ data: walletRow, error: selectError })
        },
      }
      chain.table = table
      return chain
    },
  }
  return { db, rpcCalls }
}

describe('applyWalletEntry → wallet_apply RPC', () => {
  it('maps every field onto the p_* RPC args', async () => {
    const { db, rpcCalls } = mockDb({ rpcResult: { data: 4400, error: null } })
    const balance = await applyWalletEntry(db, {
      locationId: 'loc-1',
      kind: 'draw',
      amountCents: -600,
      meter: 'wa_template_send',
      qty: 12,
      unitRateCents: 50,
      note: 'daily rollup',
    })
    expect(balance).toBe(4400)
    expect(rpcCalls).toEqual([{
      name: 'wallet_apply',
      args: {
        p_location_id: 'loc-1',
        p_kind: 'draw',
        p_amount_cents: -600,
        p_meter: 'wa_template_send',
        p_qty: 12,
        p_unit_rate_cents: 50,
        p_invoice_ref: null,
        p_note: 'daily rollup',
        p_created_by: null,
      },
    }])
  })

  it('defaults optional fields to null (topup with invoiceRef)', async () => {
    const { db, rpcCalls } = mockDb({ rpcResult: { data: 5000, error: null } })
    await applyWalletEntry(db, {
      locationId: 'loc-1', kind: 'topup', amountCents: 5000, invoiceRef: 'INV-1', createdBy: 'prof-9',
    })
    expect(rpcCalls[0].args).toMatchObject({
      p_kind: 'topup', p_amount_cents: 5000, p_invoice_ref: 'INV-1', p_created_by: 'prof-9',
      p_meter: null, p_qty: null, p_unit_rate_cents: null, p_note: null,
    })
  })

  it('sends p_amount_cents null for expiry_reset (the RPC computes -balance under the lock)', async () => {
    const { db, rpcCalls } = mockDb({ rpcResult: { data: 0, error: null } })
    const balance = await applyWalletEntry(db, {
      locationId: 'loc-1', kind: 'expiry_reset', amountCents: -1234, note: 'boundary',
    })
    expect(balance).toBe(0)
    expect(rpcCalls[0].args.p_kind).toBe('expiry_reset')
    expect(rpcCalls[0].args.p_amount_cents).toBeNull()
  })

  it('requires an integer amountCents for non-reset kinds without calling the RPC', async () => {
    const { db, rpcCalls } = mockDb()
    await expect(applyWalletEntry(db, { locationId: 'loc-1', kind: 'topup' }))
      .rejects.toThrow(/integer amountCents/)
    await expect(applyWalletEntry(db, { locationId: 'loc-1', kind: 'draw', amountCents: 1.5 }))
      .rejects.toThrow(/integer amountCents/)
    expect(rpcCalls).toHaveLength(0)
  })

  it('requires locationId and kind', async () => {
    const { db } = mockDb()
    await expect(applyWalletEntry(db, { kind: 'topup', amountCents: 100 }))
      .rejects.toThrow(/locationId/)
    await expect(applyWalletEntry(db, { locationId: 'loc-1', amountCents: 100 }))
      .rejects.toThrow(/kind/)
  })

  it('throws a wrapped error when the RPC errors (e.g. grace floor breach)', async () => {
    const { db } = mockDb({ rpcResult: { data: null, error: { message: 'grace floor breached' } } })
    await expect(applyWalletEntry(db, { locationId: 'loc-1', kind: 'draw', amountCents: -99999 }))
      .rejects.toThrow(/applyWalletEntry: grace floor breached/)
  })
})

describe('getWallet', () => {
  it('returns the wallet row', async () => {
    const row = { location_id: 'loc-1', balance_cents: 250, period_start: '2026-07-01' }
    const { db } = mockDb({ walletRow: row })
    expect(await getWallet(db, 'loc-1')).toEqual(row)
  })

  it('returns null when the location has no wallet yet', async () => {
    const { db } = mockDb({ walletRow: null })
    expect(await getWallet(db, 'loc-1')).toBeNull()
  })

  it('throws a wrapped error on a select error', async () => {
    const { db } = mockDb({ selectError: { message: 'boom' } })
    await expect(getWallet(db, 'loc-1')).rejects.toThrow(/getWallet: boom/)
  })

  it('requires locationId', async () => {
    const { db } = mockDb()
    await expect(getWallet(db, undefined)).rejects.toThrow(/locationId/)
  })
})
