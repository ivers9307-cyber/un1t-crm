// W1.M3b — the onboarding-pace nudge discovers its live locations through the
// membership seam, not settings->'glofox'.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/onboarding-journey-data', () => ({ loadJourneyLane: vi.fn(async () => ({ lane: [] })) }))
vi.mock('@/lib/customer-nudge-claim', () => ({ sendNudgeOnce: vi.fn(), readReachableContacts: vi.fn(), nudgeFailed: vi.fn() }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
}))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadJourneyLane } from '@/lib/onboarding-journey-data'
import { fakeDb } from '@/lib/time-off.test-helpers'
import {
  ESTATE_2026_10, STILLORGAN_ID, SLICE_BUT_NONE, REGISTRY_ONLY, legacyGlofoxDiscovery, locationsResolver,
} from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const dbFor = (rows, opts) => fakeDb(locationsResolver(rows, opts))
const visited = () => loadJourneyLane.mock.calls.map(([, locationId]) => locationId)

beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/notify-onboarding-pace — discovery through the membership seam (W1.M3b)', () => {
  it('the live estate paces exactly the locations the old slice rule paced: Stillorgan only', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(visited()).toEqual(legacyGlofoxDiscovery(ESTATE_2026_10))
    expect(out).toMatchObject({ ok: true, locations: 1, locations_skipped: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('notify-onboarding-pace')
  })

  it('slice-but-none is NOT paced; registry-only glofox IS', async () => {
    h.db = dbFor([...ESTATE_2026_10, SLICE_BUT_NONE, REGISTRY_ONLY])
    await GET(req())
    expect(visited().sort()).toEqual([STILLORGAN_ID, REGISTRY_ONLY.id].sort())
  })

  it('a failed seam read answers 500 and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'membership_source unreadable' } })
    expect((await GET(req())).status).toBe(500)
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
