// REGISTRYREAD.1a — POST /api/locations/[id]/connections/refresh. The
// integration tabs fire-and-forget this call, so a failed registry sync's
// error string is read by no one: it must be logged. The response shape is
// unchanged (success, per-platform results).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/connection-registry', () => ({
  DUAL_READ_PLATFORMS: ['glofox', 'unifi'],
  syncConnectionFromLegacy: vi.fn(async () => ({ action: 'upserted' })),
}))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { syncConnectionFromLegacy } from '@/lib/connection-registry'
import { logError } from '@/lib/log'

const LOC = 'loc-test'
const OWNER = { id: 'o', isMaster: false, role: 'owner', rolesByLocation: { [LOC]: 'owner' }, locations: [{ id: LOC }] }
const props = { params: Promise.resolve({ id: LOC }) }

function db() {
  const b = {
    select() { return b },
    eq() { return b },
    single: async () => ({ data: { id: LOC, settings: {} }, error: null }),
  }
  return { from: () => b }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
  createServerClient.mockReturnValue(db())
})

describe('POST connections/refresh', () => {
  it('a failed platform sync is logged with location + platform; the response is unchanged and the rest still sync', async () => {
    const boom = new Error('registry write failed')
    syncConnectionFromLegacy.mockRejectedValueOnce(boom)

    const res = await POST({}, props)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { results: { glofox: 'error: registry write failed', unifi: 'upserted' } } })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('integrations', 'registry sync failed', { locationId: LOC, platform: 'glofox', err: boom })
  })

  it('a clean refresh logs nothing', async () => {
    const res = await POST({}, props)
    expect((await res.json()).data.results).toEqual({ glofox: 'upserted', unifi: 'upserted' })
    expect(logError).not.toHaveBeenCalled()
  })
})
