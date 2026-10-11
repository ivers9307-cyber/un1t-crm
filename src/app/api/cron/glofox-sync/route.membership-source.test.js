// W1.M3b — the nightly member sync discovers its locations through the
// membership seam (locations.membership_source + membershipSourceState), not
// by sniffing settings->'glofox'. Three facts pinned:
//   1. the live estate visits exactly the locations the old slice rule visited
//      (Stillorgan only): byte-identical for UN1T;
//   2. a location whose slice is complete but whose column says 'none' is not
//      visited (the behaviour change), and a registry-only Glofox location is;
//   3. a failed seam read is a 500 with NO heartbeat, never "no locations".
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/tenant-heartbeat', () => ({ stampTenantHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/glofox-catalog', () => ({ syncMembershipCatalog: vi.fn(async () => ({})) }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn(async () => ({ action: 'update' })) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  // Credentials come from the registry-first read, which the seam and the
  // run both call; a location with no legacy slice can still have them.
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
  fetchAllMembersPage: vi.fn(async () => ({ data: [], total: 0, hasMore: false })),
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
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
}
const visited = (db) => queriesOf(db, 'glofox_sync_runs', 'insert').map((q) => q.payload.location_id)

beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/glofox-sync — discovery through the membership seam (W1.M3b)', () => {
  it('the live estate visits exactly the locations the old slice rule visited: Stillorgan, nobody else', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited(h.db)).toEqual([STILLORGAN_ID])
    expect(visited(h.db)).toEqual(legacyGlofoxDiscovery(ESTATE_2026_10))
    expect(out).toMatchObject({ success: true, locations_processed: 1, locations_skipped: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-sync', {
      locations_processed: 1, failed_locations: 0, skipped_unconfigured: 0, skipped_unknown: 0, skipped_source_changed: 0,
    })
    // Hatch Street / CCF Autos (empty slices) are not even asked for credentials any more.
    for (const call of glofoxCredentialsForLocation.mock.calls) expect(call[1]).toBe(STILLORGAN_ID)
  })

  it('a location with a complete settings.glofox slice but membership_source = none is NOT synced; a registry-only glofox location IS', async () => {
    h.db = dbFor([...ESTATE_2026_10, SLICE_BUT_NONE, REGISTRY_ONLY])
    await GET(req())
    expect(visited(h.db).sort()).toEqual([STILLORGAN_ID, REGISTRY_ONLY.id].sort())
    expect(visited(h.db)).not.toContain(SLICE_BUT_NONE.id)
  })

  it('a glofox location whose credentials are missing is skipped at discovery, counted, and writes no run row', async () => {
    glofoxCredentialsForLocation.mockImplementation(async (_db, id) => (
      id === REGISTRY_ONLY.id ? { branchId: null, apiKey: null, apiToken: null, readError: null } : { branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }
    ))
    h.db = dbFor([...ESTATE_2026_10, REGISTRY_ONLY])
    const out = await (await GET(req())).json()
    expect(visited(h.db)).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ locations_processed: 1, locations_skipped: 1, skipped_unconfigured: 1, skipped_unknown: 0 })
  })

  it('a failed seam read answers 500 and does NOT stamp the heartbeat (never "no locations")', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'membership_source unreadable' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(visited(h.db)).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('no glofox location at all is a healthy quiet run (stamps), not an error', async () => {
    h.db = dbFor(ESTATE_2026_10.filter((r) => r.id !== STILLORGAN_ID))
    const out = await (await GET(req())).json()
    expect(out).toMatchObject({ success: true, locations_processed: 0, message: 'No locations with Glofox credentials configured.' })
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-sync', expect.objectContaining({ locations_processed: 0, skipped_unknown: 0 }))
  })

  it('Stillorgan whose credentials read FAILS at discovery is skipped_unknown on the stamp, never the quiet "no locations" message', async () => {
    glofoxCredentialsForLocation.mockImplementation(async (_db, id) => (
      id === STILLORGAN_ID ? { branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' } : { branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }
    ))
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited(h.db)).toEqual([])
    expect(out).toMatchObject({ locations_processed: 0, locations_skipped: 1, skipped_unknown: 1 })
    expect(out.message).not.toBe('No locations with Glofox credentials configured.')
    expect(out.message).toMatch(/1 unreadable/)
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-sync', expect.objectContaining({ skipped_unknown: 1 }))
  })
})
