// REGISTRYREAD.1b — the weekly class-knowledge cron skips a studio with no
// Glofox silently (by design), but a studio whose Glofox settings could not
// be READ is listed in results as a failure, not skipped as "not a Glofox
// location". The real importClassKnowledge runs; only Glofox is stubbed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeDb = {
  from: () => {
    const b = {}
    for (const m of ['select', 'eq']) b[m] = () => b
    b.then = (resolve) => Promise.resolve({ data: [{ id: 'loc-1', name: 'Studio 1' }], error: null }).then(resolve)
    return b
  },
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  fetchUpcomingEvents: vi.fn(async () => { throw new Error('fetchUpcomingEvents must not be called') }),
}))

import { GET } from './route.js'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
})

describe('GET /api/cron/sync-class-knowledge — REGISTRYREAD.1b', () => {
  it('an unreadable settings row is listed in results, not skipped; the heartbeat still stamps', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const body = await (await GET(req())).json()
    expect(body).toEqual({ success: true, results: [{ location: 'Studio 1', ok: false, reason: 'glofox_settings_unreadable' }] })
    expect(stampHeartbeat).toHaveBeenCalledWith('sync-class-knowledge')
  })

  it('a studio with no Glofox is still skipped silently', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: null })
    const body = await (await GET(req())).json()
    expect(body).toEqual({ success: true, results: [] })
    expect(stampHeartbeat).toHaveBeenCalledWith('sync-class-knowledge')
  })
})
