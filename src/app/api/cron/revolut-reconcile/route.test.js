// REVPAY.3 — the reconcile cron's route: CRON_SECRET gate, stamp only on a
// healthy run, 500 (no stamp) otherwise. The run itself is
// src/lib/revolut-reconcile.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/revolut-reconcile', () => ({ runRevolutReconcile: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { GET } from './route'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runRevolutReconcile } from '@/lib/revolut-reconcile'

const req = (auth) => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 's3cret')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('GET /api/cron/revolut-reconcile', () => {
  it('refuses a request without the cron secret', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
    expect(runRevolutReconcile).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a healthy run stamps the heartbeat with its counts', async () => {
    const counts = { checked: 2, settled: 1 }
    runRevolutReconcile.mockResolvedValue({ healthy: true, counts })
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: counts })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('revolut-reconcile', counts)
  })

  it('an unhealthy run answers 500 and leaves the heartbeat to go stale', async () => {
    runRevolutReconcile.mockResolvedValue({ healthy: false, counts: { list_failed: ['cars'] } })
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Reconcile run incomplete', data: { list_failed: ['cars'] } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a run that throws answers 500 without a stamp', async () => {
    runRevolutReconcile.mockRejectedValue(new Error('relation secret_v does not exist'))
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Reconcile run failed' })
    expect(JSON.stringify(body)).not.toContain('secret_v')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
