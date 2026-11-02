// TRIALSTUDIO.7 — the process-trial-purchases cron runs the Hatch Street
// settle sweep after the queue loop. The heartbeat rule: a sweep that could
// not read its rows skips the stamp (like the reaper); per-row errors and a
// thrown sweeper are counted and do not.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ stamp: vi.fn(), claim: vi.fn(), settle: vi.fn(), sweep: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: mocks.stamp }))
vi.mock('@/lib/trial-purchase-queue', () => ({ claimAndProcessTrialPurchase: mocks.claim, MAX_ATTEMPTS: 5 }))
vi.mock('@/lib/trial-purchase-un1t-settle', () => ({ settleUn1tTrialPurchases: mocks.settle }))
vi.mock('@/lib/trial-checkout-purchase-sweep', () => ({ sweepCheckoutTrialPurchases: mocks.sweep }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      for (const op of ['update', 'select', 'eq', 'lt', 'gte', 'order', 'limit']) b[op] = () => b
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
      return b
    },
  }),
}))

import { GET } from './route'

const call = () => GET(new Request('http://x/api/cron/process-trial-purchases', { headers: { authorization: 'Bearer s3cret' } }))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 's3cret'
  mocks.settle.mockResolvedValue({ settled: 0, expired: 0, errors: 0, readFailed: false })
  mocks.sweep.mockResolvedValue({ ok: true, locations: 0, checked: 0, enrolled: 0, already: 0, failed: 0 })
})

describe('process-trial-purchases cron: the un1t settle sweep', () => {
  it('counts the sweep in stats and stamps the heartbeat, per-row errors included', async () => {
    mocks.settle.mockResolvedValue({ settled: 2, expired: 1, errors: 1, raceLost: 1, passwordPending: 1, readFailed: false })
    const body = await (await call()).json()
    expect(body).toMatchObject({ success: true, un1t_settled: 2, un1t_expired: 1, un1t_errors: 1, un1t_race_lost: 1, un1t_password_pending: 1, un1t_read_failed: 0 })
    expect(mocks.settle).toHaveBeenCalledTimes(1)
    expect(mocks.stamp).toHaveBeenCalledWith('process-trial-purchases', expect.objectContaining({ un1t_settled: 2 }))
  })

  it('a sweep that could not read its rows skips the heartbeat', async () => {
    mocks.settle.mockResolvedValue({ settled: 0, expired: 0, errors: 1, readFailed: true })
    const body = await (await call()).json()
    expect(body).toMatchObject({ success: true, un1t_read_failed: 1 })
    expect(mocks.stamp.mock.calls.filter((c) => c[0] === 'process-trial-purchases')).toEqual([])
  })

  it('a thrown sweeper is counted and does not stop the heartbeat', async () => {
    mocks.settle.mockRejectedValue(new Error('bug'))
    const r = await call()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ success: true, un1t_errors: 1, un1t_read_failed: 0 })
    expect(mocks.stamp.mock.calls.filter((c) => c[0] === 'process-trial-purchases')).toHaveLength(1)
  })
})

// STILL39SEQ.1 — the checkout €39 purchase sweep is its own arm with its own
// heartbeat row, stamped only on a clean sweep and never able to stop the
// parent's stamp.
describe('process-trial-purchases cron: the checkout purchase sequence sweep', () => {
  const sweepStamps = () => mocks.stamp.mock.calls.filter((c) => c[0] === 'trial-checkout-purchase-sweep')

  it('a clean sweep stamps its own row with its outcome, and the parent row still stamps', async () => {
    mocks.sweep.mockResolvedValue({ ok: true, locations: 1, checked: 2, enrolled: 1, already: 1, failed: 0 })
    const body = await (await call()).json()
    expect(body).toMatchObject({ success: true, checkout_seq_checked: 2, checkout_seq_enrolled: 1 })
    expect(mocks.sweep).toHaveBeenCalledTimes(1)
    expect(sweepStamps()).toEqual([['trial-checkout-purchase-sweep', { locations: 1, checked: 2, enrolled: 1, already: 1, failed: 0 }]])
    expect(mocks.stamp).toHaveBeenCalledWith('process-trial-purchases', expect.any(Object))
  })

  it('a sweep that was not ok skips its own stamp only', async () => {
    mocks.sweep.mockResolvedValue({ ok: false, locations: 1, checked: 1, enrolled: 0, already: 0, failed: 1 })
    await call()
    expect(sweepStamps()).toEqual([])
    expect(mocks.stamp).toHaveBeenCalledWith('process-trial-purchases', expect.any(Object))
  })

  it('a thrown sweep skips its own stamp, never fails the run, and the parent row still stamps', async () => {
    mocks.sweep.mockRejectedValue(new Error('bug'))
    const r = await call()
    expect(r.status).toBe(200)
    expect(sweepStamps()).toEqual([])
    expect(mocks.stamp).toHaveBeenCalledWith('process-trial-purchases', expect.any(Object))
  })

  it('runs even when the un1t settle sweep could not read its rows', async () => {
    mocks.settle.mockResolvedValue({ settled: 0, expired: 0, errors: 1, readFailed: true })
    await call()
    expect(mocks.sweep).toHaveBeenCalledTimes(1)
    expect(sweepStamps()).toHaveLength(1)
  })
})
