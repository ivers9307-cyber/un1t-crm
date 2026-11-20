// ROUTEWRAP.C7 — the monthly wallet expiry-reset on defineCron. The wrapper
// owns the secret check, the error boundary and the stamp; the job keeps its
// order per wallet (expiry entry first, then the period advance) and its
// idempotency (an advanced period_start matches nothing on a rerun).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/wallet', async (importOriginal) => ({ ...(await importOriginal()), applyWalletEntry: vi.fn(async () => ({})) }))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')
const { applyWalletEntry } = await import('@/lib/wallet')

const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/wallet-monthly-reset', { headers: authorization ? { authorization } : {} })
const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const L3 = 'a0000000-0000-0000-0000-000000000003'

function seed() {
  return createFakeDb({
    tables: {
      wallets: [
        { location_id: L1, balance_cents: 500, period_start: '2026-11-01' }, // pinned, due, has credit → reset
        { location_id: L2, balance_cents: 0, period_start: '2026-11-01' }, // pinned, due, empty → advanced
        { location_id: L3, balance_cents: 900, period_start: '2026-11-01' }, // unpinned → skipped
      ],
      location_plans: [
        { location_id: L1, plan_version_id: 'v1', active: true },
        { location_id: L2, plan_version_id: 'v1', active: true },
      ],
      plan_versions: [{ id: 'v1', plan_id: 'p1' }],
      plans: [{ id: 'p1', kind: 'tier' }],
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-12-01T05:10:00Z'))
  process.env.CRON_SECRET = 'shh'
  h.clients = 0
  h.db = seed()
})

describe('GET /api/cron/wallet-monthly-reset', () => {
  it('refuses a caller without the cron secret: no client, nothing read, nothing moved or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(h.db.calls).toHaveLength(0)
    expect(applyWalletEntry).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run resets, advances and skips as before, then stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, today: '2026-12-01', newPeriod: '2026-12-01', reset: 1, advanced: 1, skipped: 1, failed: 0 })
    expect(applyWalletEntry).toHaveBeenCalledTimes(1)
    expect(applyWalletEntry).toHaveBeenCalledWith(h.db, expect.objectContaining({ locationId: L1, kind: 'expiry_reset' }))
    expect(h.db.tables.wallets.map((w) => w.period_start)).toEqual(['2026-12-01', '2026-12-01', '2026-11-01'])
    expect(stampHeartbeat.mock.calls).toEqual([['wallet-monthly-reset', { today: '2026-12-01', reset: 1, advanced: 1, skipped: 1 }]])
  })

  it('posts the expiry entry before advancing the period, and a rerun matches nothing', async () => {
    const order = []
    applyWalletEntry.mockImplementationOnce(async () => { order.push(['entry', h.db.tables.wallets[0].period_start]) })
    await GET(req())
    expect(order).toEqual([['entry', '2026-11-01']])
    vi.clearAllMocks()
    const again = await (await GET(req())).json()
    expect(again).toMatchObject({ success: true, reset: 0, advanced: 0, skipped: 3, failed: 0 })
    expect(applyWalletEntry).not.toHaveBeenCalled()
  })

  it('one wallet failing answers success but withholds the stamp', async () => {
    applyWalletEntry.mockRejectedValueOnce(new Error('wallet_apply failed'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, reset: 0, advanced: 1, failed: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('every due wallet failing is a failed run: 500, fixed line, nothing stamped', async () => {
    h.db.errors.wallets = { update: { message: 'permission denied for table wallets' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'Every wallet due a reset failed', reset: 1, advanced: 1, failed: 2 })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed wallets read: 500, fixed line, no database text, nothing moved or stamped', async () => {
    h.db.errors.wallets = { select: { message: 'permission denied for table wallets' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read wallets' })
    expect(applyWalletEntry).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('wallet-monthly-reset', expect.any(String), expect.objectContaining({ err: expect.any(Object) }))
  })

  it('a failed location_plans read: 500, fixed line, nothing moved or stamped', async () => {
    h.db.errors.location_plans = { select: { message: 'relation does not exist' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read location plans' })
    expect(applyWalletEntry).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
