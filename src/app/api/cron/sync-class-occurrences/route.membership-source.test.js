// W1.M3b — the class-occurrence sync discovers its locations through the
// membership seam, not settings->'glofox'.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/class-occurrences', () => ({ syncOccurrencesForLocation: vi.fn(async () => ({ ok: true, upserted: 1, trainerApiCalls: 0 })) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
}))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncOccurrencesForLocation } from '@/lib/class-occurrences'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { fakeDb } from '@/lib/time-off.test-helpers'
import {
  ESTATE_2026_10, STILLORGAN_ID, SLICE_BUT_NONE, REGISTRY_ONLY, legacyGlofoxDiscovery, locationsResolver,
} from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const dbFor = (rows, opts) => fakeDb(locationsResolver(rows, opts))
const visited = () => syncOccurrencesForLocation.mock.calls.map(([, { locationId }]) => locationId)

beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/sync-class-occurrences — discovery through the membership seam (W1.M3b)', () => {
  it('the live estate visits exactly the locations the old slice rule visited: Stillorgan only', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(visited()).toEqual(legacyGlofoxDiscovery(ESTATE_2026_10))
    expect(out.stats).toEqual({ locations: 1, upserted: 1, errors: 0, trainer_api_calls: 0, reconcile_errors: 0, skipped: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('sync-class-occurrences', out.stats)
    for (const call of glofoxCredentialsForLocation.mock.calls) expect(call[1]).toBe(STILLORGAN_ID)
  })

  it('slice-but-none is NOT synced; registry-only glofox IS', async () => {
    h.db = dbFor([...ESTATE_2026_10, SLICE_BUT_NONE, REGISTRY_ONLY])
    await GET(req())
    expect(visited().sort()).toEqual([STILLORGAN_ID, REGISTRY_ONLY.id].sort())
  })

  it('an unconfigured glofox location is skipped and counted in the stats the heartbeat carries', async () => {
    glofoxCredentialsForLocation.mockImplementation(async (_db, id) => (
      id === REGISTRY_ONLY.id ? { branchId: null, apiKey: null, apiToken: null, readError: null } : { branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }
    ))
    h.db = dbFor([...ESTATE_2026_10, REGISTRY_ONLY])
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out.stats).toMatchObject({ locations: 1, skipped: 1 })
  })

  it('a failed seam read answers 500 and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'membership_source unreadable' } })
    expect((await GET(req())).status).toBe(500)
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
