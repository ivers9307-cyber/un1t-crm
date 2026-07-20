// INTEG-C3 — route test for the daily overage draw poster.
//
// Focus: the cumulative-minus-drawn idempotence contract, per-meter
// pricing (wa at wa_marketing — no marketing/utility split in the
// rollup yet; email per-1k rounded UP; ai per message), the −€10
// grace-floor clamp (+ the RPC-race retry), the wallet period-mismatch
// safety skip, and heartbeat-only-on-clean-run. DB + RPC are stubbed
// per the cron route-test convention (see ac-external-rule).

import { describe, it, expect, vi, beforeEach } from 'vitest'

let tables = {}
let rpcMock
const fakeDb = {
  from: (t) => {
    const rows = tables[t] ?? []
    const state = { head: false }
    const b = {}
    for (const m of ['eq', 'neq', 'in', 'gte', 'lt', 'gt', 'order', 'limit']) b[m] = () => b
    b.select = (_cols, opts) => { if (opts?.head) state.head = true; return b }
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    b.single = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    b.then = (resolve, reject) => {
      const out = state.head
        ? { count: rows.length, error: null }
        : { data: rows, error: null }
      return Promise.resolve(out).then(resolve, reject)
    }
    return b
  },
  rpc: (...args) => rpcMock(...args),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { clearBillingStateCache } from '@/lib/wallet-enforcement'

function req(auth = 'Bearer test-secret') {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } }
}

const TIER_PIN = (locationId = 'loc-1') => ({
  location_id: locationId,
  active: true,
  version: {
    plan: { id: 'plan-1', kind: 'tier', slug: 'starter' },
    effective_from: '2020-01-01',
    allowances: { wa_template_send: 10, email_send: 100, ai_message: 5 },
    unit_rates_cents: { wa_marketing: 5, wa_utility: 2, email_per_1k: 150, ai_message: 3 },
  },
})

let errSpy
beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  tables = {}
  rpcMock = vi.fn(async () => ({ data: 0, error: null }))
  clearBillingStateCache()
  vi.clearAllMocks()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/cron/wallet-overage-draws', () => {
  it('rejects a missing/wrong bearer', async () => {
    expect((await GET(req(null))).status).toBe(401)
    expect((await GET(req('Bearer wrong'))).status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('no pinned locations → clean no-op run, heartbeat stamped', async () => {
    tables = { location_plans: [] }
    const res = await GET(req())
    const body = await res.json()
    expect(body).toMatchObject({ success: true, locations: 0, draws: 0, failed: 0 })
    expect(rpcMock).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('wallet-overage-draws', expect.objectContaining({ draws: 0 }))
  })

  it('posts one delta draw per meter with the documented pricing', async () => {
    tables = {
      location_plans: [TIER_PIN()],
      wallets: [{ location_id: 'loc-1', balance_cents: 1000, period_start: null }],
      usage_rollups_daily: [
        { meter: 'wa_template_send', quantity: 14 },   // overage 4 × 5c = 20c
        { meter: 'email_send', quantity: 1001 },        // overage 901 → ceil(901×150/1000) = 136c
      ],
      usage_events: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id })), // ai usage 7, overage 2 × 3c = 6c
      wallet_transactions: [
        { meter: 'wa_template_send', amount_cents: -5, kind: 'draw' }, // already drawn 5c → delta 15c
        { meter: 'ai_message', amount_cents: -6, kind: 'draw' },       // fully drawn → NO ai draw
      ],
    }
    let balance = 1000
    rpcMock = vi.fn(async (_fn, args) => {
      balance += args.p_amount_cents
      return { data: balance, error: null }
    })

    const res = await GET(req())
    const body = await res.json()

    expect(rpcMock).toHaveBeenCalledTimes(2)
    const calls = rpcMock.mock.calls.map(([fn, args]) => ({ fn, ...args }))
    expect(calls[0]).toMatchObject({
      fn: 'wallet_apply', p_location_id: 'loc-1', p_kind: 'draw',
      p_amount_cents: -15, p_meter: 'wa_template_send', p_qty: 4, p_unit_rate_cents: 5,
    })
    expect(calls[1]).toMatchObject({
      fn: 'wallet_apply', p_kind: 'draw',
      p_amount_cents: -136, p_meter: 'email_send', p_qty: 901, p_unit_rate_cents: 150,
    })
    expect(body).toMatchObject({ success: true, draws: 2, drawnCents: 151, failed: 0 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: everything already drawn → zero RPC calls', async () => {
    tables = {
      location_plans: [TIER_PIN()],
      wallets: [{ location_id: 'loc-1', balance_cents: 500, period_start: null }],
      usage_rollups_daily: [{ meter: 'email_send', quantity: 1001 }],
      usage_events: [],
      wallet_transactions: [{ meter: 'email_send', amount_cents: -136, kind: 'draw' }],
    }
    const body = await (await GET(req())).json()
    expect(rpcMock).not.toHaveBeenCalled()
    expect(body).toMatchObject({ draws: 0, failed: 0 })
  })

  it('clamps a draw at the −€10 grace floor and logs the unbilled shortfall', async () => {
    tables = {
      location_plans: [TIER_PIN()],
      wallets: [{ location_id: 'loc-1', balance_cents: -800, period_start: null }],
      // email overage 3334 units → ceil(3334×150/1000) = 501c cumulative
      usage_rollups_daily: [{ meter: 'email_send', quantity: 3434 }],
      usage_events: [],
      wallet_transactions: [],
    }
    rpcMock = vi.fn(async (_fn, args) => ({ data: -800 + args.p_amount_cents, error: null }))

    const body = await (await GET(req())).json()

    // Only 200c of headroom above the floor: −800 − 200 = −1000 exactly.
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_amount_cents: -200, p_meter: 'email_send' })
    expect(body).toMatchObject({ draws: 1, drawnCents: 200, shortfallCents: 301, failed: 0 })
    expect(errSpy.mock.calls.some(([m]) => /UNBILLED/.test(String(m)))).toBe(true)
  })

  it('retries ONCE re-clamped when the RPC itself raises the grace floor (concurrent movement)', async () => {
    tables = {
      location_plans: [TIER_PIN()],
      wallets: [{ location_id: 'loc-1', balance_cents: -890, period_start: null }],
      // email overage 1334 units → ceil(1334×150/1000) = 201c cumulative
      usage_rollups_daily: [{ meter: 'email_send', quantity: 1434 }],
      usage_events: [],
      wallet_transactions: [],
    }
    rpcMock = vi.fn()
      .mockImplementationOnce(async () => {
        // Simulate a concurrent draw landing between our read and the lock.
        tables.wallets[0].balance_cents = -950
        return { data: null, error: { message: 'wallet_apply: grace floor breached for location loc-1 (kind=draw, meter=email_send): -950 + -110 = -1060 < -1000' } }
      })
      .mockImplementationOnce(async (_fn, args) => ({ data: -950 + args.p_amount_cents, error: null }))

    const body = await (await GET(req())).json()

    expect(rpcMock).toHaveBeenCalledTimes(2)
    // First attempt: clamp vs the stale −890 read → −110.
    expect(rpcMock.mock.calls[0][1].p_amount_cents).toBe(-110)
    // Retry: re-read −950 → only 50c of headroom left.
    expect(rpcMock.mock.calls[1][1].p_amount_cents).toBe(-50)
    expect(body).toMatchObject({ draws: 1, drawnCents: 50, failed: 0 })
  })

  it('skips a wallet whose period_start does not match the billing month (reset cron behind)', async () => {
    tables = {
      location_plans: [TIER_PIN()],
      wallets: [{ location_id: 'loc-1', balance_cents: 1000, period_start: '2020-01-01' }],
      usage_rollups_daily: [{ meter: 'email_send', quantity: 5000 }],
      usage_events: [],
      wallet_transactions: [],
    }
    const body = await (await GET(req())).json()
    expect(rpcMock).not.toHaveBeenCalled()
    expect(body).toMatchObject({ skippedPeriodMismatch: 1, draws: 0, failed: 0 })
    expect(errSpy.mock.calls.some(([m]) => /period_start/.test(String(m)))).toBe(true)
  })

  it('a non-grace RPC failure marks the run failed and WITHHOLDS the heartbeat', async () => {
    tables = {
      location_plans: [TIER_PIN()],
      wallets: [{ location_id: 'loc-1', balance_cents: 1000, period_start: null }],
      usage_rollups_daily: [{ meter: 'email_send', quantity: 1001 }],
      usage_events: [],
      wallet_transactions: [],
    }
    rpcMock = vi.fn(async () => ({ data: null, error: { message: 'connection reset' } }))
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ failed: 1, draws: 0 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
