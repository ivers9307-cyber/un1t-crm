// INTEG-C3 — wallet/allowance enforcement: pure decision core +
// billing-state assembly + the fail-open contract.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  canSpend, priceOverageCents, drawDeltaCents, clampDrawToFloor,
  isGraceFloorError, billingMonthWindow,
  sumRollupUsage, countAiMessages, sumDrawnByMeter,
  getBillingState, checkSpend, logTransactionalWalletState,
  clearBillingStateCache, TRANSACTIONAL_GRACE_FLOOR_CENTS,
} from './wallet-enforcement.js'

const state = ({ allowance = 100, used = 0, balance = 0, meterOverrides = {} } = {}) => ({
  planVersion: {
    allowances: { wa_template_send: allowance, email_send: allowance, ai_message: allowance, ...meterOverrides },
    unit_rates_cents: {},
  },
  wallet: { balance_cents: balance },
  mtdUsage: { wa_template_send: used, email_send: used, ai_message: used },
  mtdDrawnByMeter: {},
  periodStart: '2026-07-01',
})

describe('canSpend', () => {
  it('null state (no active tier pinning) always allows — zero behaviour change', () => {
    for (const cls of ['marketing', 'transactional', 'ai']) {
      expect(canSpend(null, 'email_send', cls)).toEqual({ allow: true, reason: 'unpinned' })
    }
  })
  it('within allowance always allows regardless of wallet', () => {
    const s = state({ allowance: 10, used: 9, balance: -900 })
    expect(canSpend(s, 'email_send', 'marketing')).toEqual({ allow: true, reason: 'within_allowance' })
    expect(canSpend(s, 'ai_message', 'ai').allow).toBe(true)
  })
  it('allowance boundary: used === allowance moves into the wallet band', () => {
    expect(canSpend(state({ allowance: 10, used: 10, balance: 0 }), 'email_send', 'marketing').allow).toBe(false)
    expect(canSpend(state({ allowance: 10, used: 10, balance: 1 }), 'email_send', 'marketing').allow).toBe(true)
  })
  it('marketing pauses at balance ≤ 0 once the allowance is exhausted', () => {
    expect(canSpend(state({ allowance: 0, balance: 0 }), 'wa_template_send', 'marketing'))
      .toEqual({ allow: false, reason: 'wallet_empty' })
    expect(canSpend(state({ allowance: 0, balance: -1 }), 'wa_template_send', 'marketing').allow).toBe(false)
    expect(canSpend(state({ allowance: 0, balance: 1 }), 'wa_template_send', 'marketing'))
      .toEqual({ allow: true, reason: 'wallet_funded' })
  })
  it('ai mirrors marketing (finish-then-pause is the caller\'s job)', () => {
    expect(canSpend(state({ allowance: 0, balance: 0 }), 'ai_message', 'ai'))
      .toEqual({ allow: false, reason: 'wallet_empty' })
    expect(canSpend(state({ allowance: 0, balance: 5 }), 'ai_message', 'ai').allow).toBe(true)
  })
  it('transactional is allowed down to (but not at) the −€10 floor', () => {
    expect(canSpend(state({ allowance: 0, balance: 0 }), 'email_send', 'transactional'))
      .toEqual({ allow: true, reason: 'grace_floor' })
    expect(canSpend(state({ allowance: 0, balance: -999 }), 'email_send', 'transactional'))
      .toEqual({ allow: true, reason: 'grace_floor' })
    expect(canSpend(state({ allowance: 0, balance: 50 }), 'email_send', 'transactional'))
      .toEqual({ allow: true, reason: 'wallet_funded' })
  })
  it('transactional floor boundary: at/below −1000 still allows but flags fail-open', () => {
    expect(canSpend(state({ allowance: 0, balance: TRANSACTIONAL_GRACE_FLOOR_CENTS }), 'email_send', 'transactional'))
      .toEqual({ allow: true, reason: 'grace_exhausted_fail_open' })
    expect(canSpend(state({ allowance: 0, balance: -5000 }), 'email_send', 'transactional'))
      .toEqual({ allow: true, reason: 'grace_exhausted_fail_open' })
  })
  it('a missing allowance key means allowance 0 (straight to the wallet band)', () => {
    const s = state({ balance: 0 })
    delete s.planVersion.allowances.email_send
    expect(canSpend(s, 'email_send', 'marketing').allow).toBe(false)
  })
  it('meters are independent: email exhausted does not gate WhatsApp', () => {
    const s = state({ allowance: 10, balance: 0 })
    s.mtdUsage.email_send = 10
    s.mtdUsage.wa_template_send = 3
    expect(canSpend(s, 'email_send', 'marketing').allow).toBe(false)
    expect(canSpend(s, 'wa_template_send', 'marketing').allow).toBe(true)
  })
})

describe('priceOverageCents', () => {
  const rates = { wa_marketing: 5, wa_utility: 2, email_per_1k: 150, ai_message: 1 }
  it('email prorates per email and rounds the TOTAL up to the cent', () => {
    expect(priceOverageCents('email_send', 1, rates)).toBe(1)      // 0.15c → 1c
    expect(priceOverageCents('email_send', 1000, rates)).toBe(150)
    expect(priceOverageCents('email_send', 1001, rates)).toBe(151) // 150.15c → 151c
  })
  it('ai is per message', () => {
    expect(priceOverageCents('ai_message', 42, rates)).toBe(42)
  })
  it('wa uses the caller-selected rate key (default wa_marketing — no split in rollups yet)', () => {
    expect(priceOverageCents('wa_template_send', 10, rates)).toBe(50)
    expect(priceOverageCents('wa_template_send', 10, rates, { waRateKey: 'wa_utility' })).toBe(20)
  })
  it('zero/negative/missing rates price to 0 (never invent charges)', () => {
    expect(priceOverageCents('email_send', 10, {})).toBe(0)
    expect(priceOverageCents('wa_template_send', 10, { wa_marketing: 0 })).toBe(0)
    expect(priceOverageCents('email_send', 0, rates)).toBe(0)
    expect(priceOverageCents('unknown_meter', 10, rates)).toBe(0)
  })
})

describe('drawDeltaCents / clampDrawToFloor / isGraceFloorError', () => {
  it('delta = cumulative − already drawn, floored at 0 (idempotent recompute)', () => {
    expect(drawDeltaCents(500, 300)).toBe(200)
    expect(drawDeltaCents(300, 300)).toBe(0)
    expect(drawDeltaCents(200, 300)).toBe(0)
  })
  it('clamps a draw so the balance lands exactly at the −€10 floor', () => {
    expect(clampDrawToFloor(500, 200)).toEqual({ drawable: 500, shortfall: 0 })
    expect(clampDrawToFloor(2000, 500)).toEqual({ drawable: 1500, shortfall: 500 })
    expect(clampDrawToFloor(100, TRANSACTIONAL_GRACE_FLOOR_CENTS)).toEqual({ drawable: 0, shortfall: 100 })
  })
  it('recognises the mig 414 RPC grace-floor rejection', () => {
    expect(isGraceFloorError(new Error('wallet_apply: grace floor breached for location x (kind=draw, meter=email_send): -900 + -200 = -1100 < -1000'))).toBe(true)
    expect(isGraceFloorError(new Error('network timeout'))).toBe(false)
  })
})

describe('billingMonthWindow', () => {
  it('brackets the Dublin calendar month with date + instant bounds', () => {
    const w = billingMonthWindow('2026-07-19')
    expect(w.monthStart).toBe('2026-07-01')
    expect(w.monthNext).toBe('2026-08-01')
    // July is IST (UTC+1): Dublin midnight = 23:00 UTC the previous day.
    expect(w.startIso).toBe('2026-06-30T23:00:00.000Z')
    expect(w.endIso).toBe('2026-07-31T23:00:00.000Z')
  })
  it('December rolls into January (GMT — Dublin midnight == UTC midnight)', () => {
    const w = billingMonthWindow('2026-12-15')
    expect(w.monthNext).toBe('2027-01-01')
    expect(w.startIso).toBe('2026-12-01T00:00:00.000Z')
  })
})

// ── IO helpers + getBillingState with a stub db ─────────────────────

// Table-keyed chainable stub. Records which tables were touched so the
// unpinned test can assert the bypass issues NO further queries.
function stubDb(tables, touched = []) {
  return {
    from: (table) => {
      touched.push(table)
      const rows = tables[table]
      if (rows instanceof Error) throw rows
      const state = { head: false }
      const b = {}
      for (const m of ['eq', 'neq', 'in', 'gte', 'lt', 'gt', 'order', 'limit']) b[m] = () => b
      b.select = (_cols, opts) => { if (opts?.head) state.head = true; return b }
      b.maybeSingle = () => Promise.resolve({ data: (rows || [])[0] ?? null, error: null })
      b.single = () => Promise.resolve({ data: (rows || [])[0] ?? null, error: null })
      b.then = (resolve, reject) => {
        const out = state.head
          ? { count: Array.isArray(rows) ? rows.length : 0, error: null }
          : { data: rows || [], error: null }
        return Promise.resolve(out).then(resolve, reject)
      }
      return b
    },
  }
}

const TIER_PIN = {
  active: true,
  version: {
    plan: { id: 'plan-1', kind: 'tier', slug: 'starter' },
    effective_from: '2026-01-01',
    allowances: { wa_template_send: 100, email_send: 1000, ai_message: 200 },
    unit_rates_cents: { wa_marketing: 5, wa_utility: 2, email_per_1k: 150, ai_message: 1 },
  },
}

beforeEach(() => {
  clearBillingStateCache()
})

describe('getBillingState', () => {
  it('returns null for an unpinned location WITHOUT touching wallet/usage tables', async () => {
    const touched = []
    const db = stubDb({ location_plans: [] }, touched)
    expect(await getBillingState(db, 'loc-1')).toBeNull()
    expect(touched).toEqual(['location_plans'])
  })

  it('returns null for a location pinned only to an addon (no tier)', async () => {
    const db = stubDb({
      location_plans: [{ active: true, version: { plan: { kind: 'addon' }, allowances: {} } }],
    })
    expect(await getBillingState(db, 'loc-1')).toBeNull()
  })

  it('assembles plan allowances, wallet balance, MTD usage and drawn cents when pinned', async () => {
    const db = stubDb({
      location_plans: [TIER_PIN],
      wallets: [{ location_id: 'loc-1', balance_cents: 250, period_start: '2026-07-01' }],
      usage_rollups_daily: [
        { meter: 'wa_template_send', quantity: 40 },
        { meter: 'wa_template_send', quantity: 20 },
        { meter: 'email_send', quantity: 500 },
      ],
      usage_events: [{ id: 1 }, { id: 2 }, { id: 3 }],
      wallet_transactions: [
        { meter: 'email_send', amount_cents: -75 },
        { meter: 'email_send', amount_cents: -25 },
        { meter: 'wa_template_send', amount_cents: -10 },
      ],
    })
    const s = await getBillingState(db, 'loc-1')
    expect(s.planVersion.allowances).toEqual(TIER_PIN.version.allowances)
    expect(s.planVersion.unit_rates_cents).toEqual(TIER_PIN.version.unit_rates_cents)
    expect(s.wallet.balance_cents).toBe(250)
    expect(s.mtdUsage).toEqual({ wa_template_send: 60, email_send: 500, ai_message: 3 })
    expect(s.mtdDrawnByMeter).toEqual({ email_send: 100, wa_template_send: 10 })
    expect(s.periodStart).toMatch(/^\d{4}-\d{2}-01$/)
  })

  it('a location with no wallet row yet reads as balance 0', async () => {
    const db = stubDb({
      location_plans: [TIER_PIN],
      wallets: [],
      usage_rollups_daily: [],
      usage_events: [],
      wallet_transactions: [],
    })
    const s = await getBillingState(db, 'loc-1')
    expect(s.wallet.balance_cents).toBe(0)
  })

  it('caches per location inside the TTL (one location_plans read for two calls)', async () => {
    const touched = []
    const db = stubDb({ location_plans: [] }, touched)
    await getBillingState(db, 'loc-1')
    await getBillingState(db, 'loc-1')
    expect(touched.filter((t) => t === 'location_plans')).toHaveLength(1)
  })
})

describe('checkSpend — the fail-open contract', () => {
  it('unpinned location → allow with reason unpinned (byte-identical old behaviour)', async () => {
    const db = stubDb({ location_plans: [] })
    expect(await checkSpend(db, 'loc-1', 'email_send', 'marketing'))
      .toEqual({ allow: true, reason: 'unpinned' })
  })

  it('pinned + exhausted allowance + empty wallet → marketing denied, transactional allowed', async () => {
    const tables = {
      location_plans: [TIER_PIN],
      wallets: [{ balance_cents: 0, period_start: '2026-07-01' }],
      usage_rollups_daily: [
        { meter: 'email_send', quantity: 1000 },
        { meter: 'wa_template_send', quantity: 100 },
      ],
      usage_events: [],
      wallet_transactions: [],
    }
    expect((await checkSpend(stubDb(tables), 'loc-1', 'email_send', 'marketing')).allow).toBe(false)
    clearBillingStateCache()
    expect((await checkSpend(stubDb(tables), 'loc-1', 'email_send', 'transactional')).allow).toBe(true)
  })

  it('ANY infrastructure error answers allow:true (never throws)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubDb({ location_plans: new Error('connection refused') })
    expect(await checkSpend(db, 'loc-1', 'email_send', 'marketing'))
      .toEqual({ allow: true, reason: 'error_fail_open' })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('logTransactionalWalletState', () => {
  it('logs LOUDLY at/below the grace floor but still reports allow:true', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubDb({
      location_plans: [TIER_PIN],
      wallets: [{ balance_cents: -1000, period_start: '2026-07-01' }],
      usage_rollups_daily: [{ meter: 'email_send', quantity: 1000 }],
      usage_events: [],
      wallet_transactions: [],
    })
    const r = await logTransactionalWalletState(db, 'loc-1', 'email_send')
    expect(r).toEqual({ allow: true, reason: 'grace_exhausted_fail_open' })
    expect(errSpy.mock.calls.some(([msg]) => /grace floor/i.test(String(msg)))).toBe(true)
    errSpy.mockRestore()
  })

  it('stays silent for an unpinned location', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = stubDb({ location_plans: [] })
    const r = await logTransactionalWalletState(db, 'loc-1', 'email_send')
    expect(r.allow).toBe(true)
    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('IO helpers — query shapes', () => {
  it('sumRollupUsage sums quantities per meter and ignores unknown meters', async () => {
    const db = stubDb({
      usage_rollups_daily: [
        { meter: 'email_send', quantity: 2 },
        { meter: 'sms_send', quantity: 99 },
        { meter: 'email_send', quantity: '3' },
      ],
    })
    expect(await sumRollupUsage(db, 'loc-1', billingMonthWindow('2026-07-19')))
      .toEqual({ wa_template_send: 0, email_send: 5 })
  })
  it('countAiMessages uses a head:true count', async () => {
    const db = stubDb({ usage_events: [{ id: 1 }, { id: 2 }] })
    expect(await countAiMessages(db, 'loc-1', billingMonthWindow('2026-07-19'))).toBe(2)
  })
  it('sumDrawnByMeter reports positive cents per meter', async () => {
    const db = stubDb({
      wallet_transactions: [
        { meter: 'ai_message', amount_cents: -30 },
        { meter: 'ai_message', amount_cents: -12 },
        { meter: null, amount_cents: -99 },
      ],
    })
    expect(await sumDrawnByMeter(db, 'loc-1', '2026-07-01')).toEqual({ ai_message: 42 })
  })
})
