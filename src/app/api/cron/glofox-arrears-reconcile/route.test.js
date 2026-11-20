// REGISTRYREAD.1b — the daily arrears reconcile records a failed Glofox
// settings read as a failure for that location, not as the clean
// `skipped: 'no_glofox_credentials'` of a studio with no Glofox. The sweep
// carries on and the heartbeat stamps exactly as before.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOCS = [
  { id: 'loc-1', name: 'Studio 1' },
  { id: 'loc-2', name: 'Studio 2' },
]
const h = vi.hoisted(() => ({ locationsError: null }))
const fakeDb = {
  from: vi.fn(() => {
    const b = {}
    for (const m of ['select', 'eq']) b[m] = () => b
    b.then = (resolve) => Promise.resolve(h.locationsError ? { data: null, error: h.locationsError } : { data: LOCS, error: null }).then(resolve)
    return b
  }),
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/glofox', () => ({ glofoxCredentialsForLocation: vi.fn() }))
vi.mock('@/lib/glofox-reconcile', () => ({
  runArrearsReconcile: vi.fn(async () => ({ dryRun: false, scanned: 3, cleared: 1, kept: 2, byReason: {}, written: 1 })),
}))

import { GET } from './route.js'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { runArrearsReconcile } from '@/lib/glofox-reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'

const req = (auth = 'Bearer test-secret', query = '') => ({
  url: `http://crm.test/api/cron/glofox-arrears-reconcile${query}`,
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.locationsError = null
})

describe('GET /api/cron/glofox-arrears-reconcile — defineCron', () => {
  it('refuses a caller without the cron secret: nothing read, nothing stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    expect(fakeDb.from).not.toHaveBeenCalled()
    expect(runArrearsReconcile).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run stamps its own row exactly once, with no outcome', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, dry_run: false, restatus_applied: false, locations: 2 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-arrears-reconcile')
  })

  it('a dry-run answers success and leaves the staleness clock alone', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
    const res = await GET(req('Bearer test-secret', '?dry=1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, dry_run: true })
    expect(runArrearsReconcile.mock.calls[0][3]).toEqual({ commit: false, allowRestatus: false })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('one studio throwing is a fixed per-location error, logged; the run still stamps', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
    runArrearsReconcile.mockRejectedValueOnce(new Error('Glofox report fetch failed (status 502)'))
    const body = await (await GET(req())).json()
    expect(body.perLocation[0]).toEqual({ location_id: 'loc-1', location_name: 'Studio 1', ok: false, error: 'reconcile failed' })
    expect(JSON.stringify(body)).not.toContain('502')
    expect(logWarn).toHaveBeenCalledWith('cron-glofox-arrears-reconcile', 'reconcile failed for location', { locationId: 'loc-1', err: 'Glofox report fetch failed (status 502)' })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('a failed locations read answers 500 with a fixed error and stamps nothing', async () => {
    h.locationsError = { message: 'permission denied for table locations' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not list locations' })
    expect(logError).toHaveBeenCalledWith('cron-glofox-arrears-reconcile', 'failed to list locations', { err: 'permission denied for table locations' })
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
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
