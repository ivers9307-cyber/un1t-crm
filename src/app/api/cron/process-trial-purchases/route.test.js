// TRIALSTUDIO.7 — the process-trial-purchases cron runs the Hatch Street
// settle sweep after the queue loop. The heartbeat rule: a sweep that could
// not read its rows skips the stamp (like the reaper); per-row errors and a
// thrown sweeper are counted and do not.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ stamp: vi.fn(), claim: vi.fn(), settle: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: mocks.stamp }))
vi.mock('@/lib/trial-purchase-queue', () => ({ claimAndProcessTrialPurchase: mocks.claim, MAX_ATTEMPTS: 5 }))
vi.mock('@/lib/trial-purchase-un1t-settle', () => ({ settleUn1tTrialPurchases: mocks.settle }))
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
})

describe('process-trial-purchases cron: the un1t settle sweep', () => {
  it('counts the sweep in stats and stamps the heartbeat, per-row errors included', async () => {
    mocks.settle.mockResolvedValue({ settled: 2, expired: 1, errors: 1, readFailed: false })
    const body = await (await call()).json()
    expect(body).toMatchObject({ success: true, un1t_settled: 2, un1t_expired: 1, un1t_errors: 1, un1t_read_failed: 0 })
    expect(mocks.settle).toHaveBeenCalledTimes(1)
    expect(mocks.stamp).toHaveBeenCalledWith('process-trial-purchases', expect.objectContaining({ un1t_settled: 2 }))
  })

  it('a sweep that could not read its rows skips the heartbeat', async () => {
    mocks.settle.mockResolvedValue({ settled: 0, expired: 0, errors: 1, readFailed: true })
    const body = await (await call()).json()
    expect(body).toMatchObject({ success: true, un1t_read_failed: 1 })
    expect(mocks.stamp).not.toHaveBeenCalled()
  })

  it('a thrown sweeper is counted and does not stop the heartbeat', async () => {
    mocks.settle.mockRejectedValue(new Error('bug'))
    const r = await call()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ success: true, un1t_errors: 1, un1t_read_failed: 0 })
    expect(mocks.stamp).toHaveBeenCalledTimes(1)
  })
})
