// src/lib/xero/tax-rates-sync.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const xfetchMock = vi.fn()
vi.mock('@/lib/xero/client', async () => {
  const actual = await vi.importActual('@/lib/xero/client')
  return { ...actual, withFreshToken: vi.fn(async () => ({ xfetch: xfetchMock })) }
})

const captured = { upserts: [], deletes: [], connUpdates: [] }
const makeChain = (table) => {
  const chain = {
    upsert: vi.fn((rows, opts) => { captured.upserts.push({ table, rows, opts }); return Promise.resolve({ error: null }) }),
    // delete().eq().lt() → resolves with a count
    delete: vi.fn(() => chain),
    update: vi.fn((patch) => { captured.connUpdates.push({ table, patch }); return chain }),
    eq: vi.fn(() => chain),
    lt: vi.fn(() => { captured.deletes.push({ table }); return Promise.resolve({ error: null, count: 1 }) }),
    then: undefined,
  }
  return chain
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: (t) => makeChain(t) }) }))

let pullTaxRates
beforeEach(async () => {
  vi.resetModules()
  xfetchMock.mockReset()
  captured.upserts = []; captured.deletes = []; captured.connUpdates = []
  ;({ pullTaxRates } = await import('./tax-rates-sync'))
})

describe('pullTaxRates', () => {
  it('maps Xero /TaxRates into cache rows and stamps the connection', async () => {
    xfetchMock.mockResolvedValueOnce({ TaxRates: [
      { Name: 'VAT on Purchases', TaxType: 'INPUT', Status: 'ACTIVE', EffectiveRate: 23, CanApplyToExpenses: true, CanApplyToRevenue: false },
      { Name: 'No VAT', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0, CanApplyToExpenses: true, CanApplyToRevenue: true },
    ] })
    const r = await pullTaxRates('loc1')
    expect(r.syncedCount).toBe(2)
    const up = captured.upserts.find((u) => u.table === 'xero_tax_rates')
    expect(up.rows[0]).toMatchObject({ location_id: 'loc1', tax_type: 'INPUT', name: 'VAT on Purchases', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true })
    expect(up.opts.onConflict).toBe('location_id,tax_type')
    expect(captured.connUpdates.some((u) => u.table === 'xero_connections' && 'tax_rates_last_synced_at' in u.patch)).toBe(true)
  })

  it('falls back to summing TaxComponents when EffectiveRate is absent', async () => {
    xfetchMock.mockResolvedValueOnce({ TaxRates: [
      { Name: 'Std', TaxType: 'TAX001', Status: 'ACTIVE', CanApplyToExpenses: true, TaxComponents: [{ Rate: 20 }, { Rate: 3 }] },
    ] })
    await pullTaxRates('loc1')
    const up = captured.upserts.find((u) => u.table === 'xero_tax_rates')
    expect(up.rows[0].effective_rate).toBe(23)
  })

  it('does NOT wipe the cache on an empty /TaxRates response (review #5)', async () => {
    // A transient 200-empty must not delete every cached rate (which
    // would blank the picker + block sends behind a green "just synced").
    xfetchMock.mockResolvedValueOnce({ TaxRates: [] })
    const r = await pullTaxRates('loc1')
    expect(r.syncedCount).toBe(0)
    expect(captured.upserts).toHaveLength(0)      // nothing upserted
    expect(captured.deletes).toHaveLength(0)      // and crucially, no stale-sweep
    // the connection is still stamped as synced (it was reached)
    expect(captured.connUpdates.some((u) => 'tax_rates_last_synced_at' in u.patch)).toBe(true)
  })
})
