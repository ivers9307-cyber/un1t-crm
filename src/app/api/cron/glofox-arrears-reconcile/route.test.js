// REGISTRYREAD.1b — the daily arrears reconcile records a failed Glofox
// settings read as a failure for that location, not as the clean
// `skipped: 'no_glofox_credentials'` of a studio with no Glofox. The sweep
// carries on and the heartbeat stamps exactly as before.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOCS = [
  { id: 'loc-1', name: 'Studio 1' },
  { id: 'loc-2', name: 'Studio 2' },
]
const fakeDb = {
  from: () => {
    const b = {}
    for (const m of ['select', 'eq']) b[m] = () => b
    b.then = (resolve) => Promise.resolve({ data: LOCS, error: null }).then(resolve)
    return b
  },
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/glofox', () => ({ glofoxCredentialsForLocation: vi.fn() }))
vi.mock('@/lib/glofox-reconcile', () => ({
  runArrearsReconcile: vi.fn(async () => ({ dryRun: false, scanned: 3, cleared: 1, kept: 2, byReason: {}, written: 1 })),
}))

import { GET } from './route.js'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { runArrearsReconcile } from '@/lib/glofox-reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const req = () => ({
  url: 'http://crm.test/api/cron/glofox-arrears-reconcile',
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
})

describe('GET /api/cron/glofox-arrears-reconcile — REGISTRYREAD.1b', () => {
  it('an unreadable settings row is a failure for that studio, not a clean skip; the next studio still reconciles', async () => {
    glofoxCredentialsForLocation
      .mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
      .mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
    const body = await (await GET(req())).json()
    expect(body.perLocation[0]).toEqual({ location_id: 'loc-1', location_name: 'Studio 1', ok: false, error: 'glofox_settings_unreadable' })
    expect(body.perLocation[1]).toMatchObject({ location_id: 'loc-2', ok: true, cleared: 1 })
    expect(runArrearsReconcile).toHaveBeenCalledTimes(1)
    expect(runArrearsReconcile.mock.calls[0][2]).toBe('loc-2')
    expect(body.success).toBe(true)
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-arrears-reconcile')
  })

  it('a studio with no Glofox is still a clean skip', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: null })
    const body = await (await GET(req())).json()
    expect(body.perLocation[0]).toEqual({ location_id: 'loc-1', location_name: 'Studio 1', skipped: 'no_glofox_credentials' })
    expect(runArrearsReconcile).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-arrears-reconcile')
  })
})
