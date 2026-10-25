// TZ.6 — notify-onboarding-pace runs hourly (30 * * * *) and paces a location
// only at its daily slot: 10:30 UTC for Europe/Dublin (as before), 10:30 local
// elsewhere, once per local day.
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
import { withSlotTables } from '@/lib/cron-daily-slot.test-helpers'
import { ESTATE_2026_10, STILLORGAN_ID, REGISTRY_ONLY, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const ZONES = [{ id: STILLORGAN_ID, timezone: 'Europe/Dublin' }, { id: REGISTRY_ONLY.id, timezone: 'America/New_York' }]
const claims = new Map()
const dbAt = (iso) => {
  vi.setSystemTime(Date.parse(iso))
  h.db = withSlotTables(fakeDb(locationsResolver([...ESTATE_2026_10, REGISTRY_ONLY])), { locations: ZONES, claims })
}
const visited = () => loadJourneyLane.mock.calls.map(([, locationId]) => locationId)

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  vi.useFakeTimers()
  claims.clear()
})

describe('TZ.6 notify-onboarding-pace', () => {
  it('Europe/Dublin paces at 10:30 UTC in summer and winter, and at no other hour', async () => {
    for (const iso of ['2026-07-01T09:30:00Z', '2026-07-01T10:30:00Z', '2026-12-01T10:30:00Z', '2026-12-01T09:30:00Z']) {
      dbAt(iso)
      await GET(req())
    }
    expect(visited()).toEqual([STILLORGAN_ID, STILLORGAN_ID])
  })

  it('America/New_York paces at 10:30 local (14:30Z summer, 15:30Z winter), once per local day', async () => {
    for (const iso of ['2026-07-01T14:30:00Z', '2026-07-01T15:30:00Z', '2026-12-01T15:30:00Z']) {
      dbAt(iso)
      await GET(req())
    }
    expect(visited()).toEqual([REGISTRY_ONLY.id, REGISTRY_ONLY.id])
  })

  it('a tick with no slot due paces nobody and never stamps; the slot tick stamps', async () => {
    dbAt('2026-07-01T03:30:00Z')
    const out = await (await GET(req())).json()
    expect(out).toMatchObject({ ok: true, nudged: 0, slot: { due: 0 } })
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
    dbAt('2026-07-01T10:30:00Z')
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })
})
