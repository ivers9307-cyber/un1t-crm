// W1.M3b — the attendance refresh discovers its locations through the
// membership seam, not settings->'glofox'. See glofox-sync's sibling test for
// the three facts pinned here.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
}))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { glofoxCredentialsForLocation } from '@/lib/glofox'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import {
  ESTATE_2026_10, STILLORGAN_ID, SLICE_BUT_NONE, REGISTRY_ONLY, legacyGlofoxDiscovery, locationsResolver,
} from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
function dbFor(rows, opts) {
  const locations = locationsResolver(rows, opts)
  return fakeDb((q) => {
    if (q.table === 'locations') return locations(q)
    if (q.table === 'glofox_sync_runs') return { data: q.action === 'insert' ? { id: 'run-1' } : null, error: null }
    if (q.table === 'contacts') return { data: [], error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
}
const visited = (db) => queriesOf(db, 'glofox_sync_runs', 'insert').map((q) => q.payload.location_id)

beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/glofox-attendance-refresh — discovery through the membership seam (W1.M3b)', () => {
  it('the live estate visits exactly the locations the old slice rule visited: Stillorgan only', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited(h.db)).toEqual([STILLORGAN_ID])
    expect(visited(h.db)).toEqual(legacyGlofoxDiscovery(ESTATE_2026_10))
    expect(out).toMatchObject({ success: true, locations_processed: 1, locations_skipped: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-attendance-refresh', expect.objectContaining({ skipped_unconfigured: 0, skipped_unknown: 0 }))
    for (const call of glofoxCredentialsForLocation.mock.calls) expect(call[1]).toBe(STILLORGAN_ID)
  })

  it('slice-but-none is NOT refreshed; registry-only glofox IS', async () => {
    h.db = dbFor([...ESTATE_2026_10, SLICE_BUT_NONE, REGISTRY_ONLY])
    await GET(req())
    expect(visited(h.db).sort()).toEqual([STILLORGAN_ID, REGISTRY_ONLY.id].sort())
  })

  it('a failed seam read answers 500 and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'membership_source unreadable' } })
    expect((await GET(req())).status).toBe(500)
    expect(visited(h.db)).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
