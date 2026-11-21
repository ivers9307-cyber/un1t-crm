// ROUTEWRAP.C13 — glofox-sync on defineCron. Pins the caller check and every
// run path's status and heartbeat stamp, which are the stamps the job made
// before the move:
//   clean / partial failure / quiet (nothing eligible) → 200, stamped;
//   every location failed / nothing eligible because a location was unreadable
//     → failure answered (500), still stamped with its counts;
//   seam read failed / a throw → 500, not stamped.
// No raw Glofox or database text leaves in the response.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, seam: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => h.db) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/tenant-heartbeat', () => ({ stampTenantHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/glofox-catalog', () => ({ syncMembershipCatalog: vi.fn(async () => ({})) }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn(async () => ({ action: 'update' })) }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
  fetchAllMembersPage: vi.fn(async () => ({ data: [{ _id: 'm1', modified: 0 }], total: 1, hasMore: false })),
  glofoxHttpStats: vi.fn(() => ({})),
  glofoxHttpStatsSince: vi.fn(() => ({ requests: 1 })),
}))
vi.mock('@/lib/membership/locations-for-source', async (importOriginal) => ({
  ...(await importOriginal()),
  locationsWithSource: vi.fn(async () => h.seam),
}))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { stampTenantHeartbeat } from '@/lib/tenant-heartbeat'
import { createServerClient } from '@/lib/supabase'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { fetchAllMembersPage } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'
import { logError } from '@/lib/log'

const A = { id: '00000000-0000-4000-8000-00000000000a', name: 'Studio A' }
const B = { id: '00000000-0000-4000-8000-00000000000b', name: 'Studio B' }
const SECRET_TEXT = 'Glofox 500: member jane@example.com +353871234567'

const req = (auth = 'Bearer test-secret') => new Request('https://x.test/api/cron/glofox-sync', { headers: auth ? { authorization: auth } : {} })
const seam = ({ eligible = [A], skipped = [], error = null } = {}) => ({ locations: [...eligible, ...skipped], eligible, skipped, error })
const runs = () => h.db.tables.glofox_sync_runs
const ZERO_SKIPS = { skipped_unconfigured: 0, skipped_unknown: 0, skipped_source_changed: 0 }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.db = createFakeDb({ tables: { locations: [{ id: A.id, name: A.name }, { id: B.id, name: B.name }], glofox_sync_runs: [] } })
  h.seam = seam()
})

describe('GET /api/cron/glofox-sync — callers', () => {
  it.each([
    ['missing', null, 'test-secret'],
    ['wrong', 'Bearer nope', 'test-secret'],
    ['unset secret', 'Bearer ', ''],
  ])('a %s secret is refused: 401, nothing read, nothing stamped', async (_label, auth, secret) => {
    process.env.CRON_SECRET = secret
    const res = await GET(req(auth))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false })
    expect(createServerClient).not.toHaveBeenCalled()
    expect(locationsWithSource).not.toHaveBeenCalled()
    expect(fetchAllMembersPage).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(stampTenantHeartbeat).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/glofox-sync — paths and stamps', () => {
  it('a clean run answers 200 and stamps exactly its own row, after the tenant row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out).toMatchObject({ success: true, locations_processed: 1, totals: { leads_processed: 1, failed_locations: 0 } })
    expect(out.per_location[0]).toMatchObject({ location_id: A.id, status: 'completed', has_error: false })
    expect(out.per_location[0]).not.toHaveProperty('first_error')
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['glofox-sync', { locations_processed: 1, failed_locations: 0, ...ZERO_SKIPS }]])
    expect(vi.mocked(stampTenantHeartbeat).mock.calls).toEqual([['glofox-sync', A.id]])
    expect(vi.mocked(stampTenantHeartbeat).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(stampHeartbeat).mock.invocationCallOrder[0])
    expect(runs()).toHaveLength(1)
    expect(runs()[0]).toMatchObject({ location_id: A.id, status: 'completed', leads_processed: 1 })
  })

  it('one location of two failing is not a failed run: 200, stamped with failed_locations, only the good tenant stamped', async () => {
    h.seam = seam({ eligible: [A, B] })
    vi.mocked(fetchAllMembersPage)
      .mockResolvedValueOnce({ data: [{ _id: 'm1', modified: 0 }], total: 1, hasMore: false })
      .mockRejectedValueOnce(new Error(SECRET_TEXT))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out).toMatchObject({ success: true, totals: { failed_locations: 1 } })
    expect(JSON.stringify(out)).not.toContain('jane@example.com')
    expect(JSON.stringify(out)).not.toContain('353871234567')
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['glofox-sync', { locations_processed: 2, failed_locations: 1, ...ZERO_SKIPS }]])
    expect(vi.mocked(stampTenantHeartbeat).mock.calls).toEqual([['glofox-sync', A.id]])
    // The detail stays on the run row.
    expect(runs().find((r) => r.location_id === B.id)).toMatchObject({ status: 'failed', first_error: SECRET_TEXT })
  })

  it('every location failing answers failure (500) and still stamps its counts; no tenant row', async () => {
    vi.mocked(fetchAllMembersPage).mockRejectedValueOnce(new Error(SECRET_TEXT))
    const res = await GET(req())
    expect(res.status).toBe(500)
    const out = await res.json()
    expect(out).toMatchObject({ success: false, error: 'Every Glofox location failed to sync', totals: { failed_locations: 1 } })
    expect(out.per_location[0]).toMatchObject({ status: 'failed', has_error: true })
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT)
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['glofox-sync', { locations_processed: 1, failed_locations: 1, ...ZERO_SKIPS }]])
    expect(stampTenantHeartbeat).not.toHaveBeenCalled()
    expect(runs()[0]).toMatchObject({ status: 'failed', first_error: SECRET_TEXT })
  })

  it('a member sync error is counted, kept on the run row, and stays out of the response', async () => {
    vi.mocked(applyMemberSync).mockResolvedValueOnce({ action: 'create', error: SECRET_TEXT })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.per_location[0]).toMatchObject({ status: 'completed', has_error: true, summary: { error: 1 } })
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT)
    expect(runs()[0].first_error).toBe(`[m1] ${SECRET_TEXT}`)
  })

  it('nothing eligible and nothing unreadable is a quiet run: 200, stamped', async () => {
    h.seam = seam({ eligible: [], skipped: [{ id: B.id, name: B.name, state: 'unconfigured' }] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, locations_processed: 0, locations_skipped: 1, skipped_unconfigured: 1 })
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['glofox-sync', { locations_processed: 0, ...ZERO_SKIPS, skipped_unconfigured: 1 }]])
    expect(runs()).toHaveLength(0)
  })

  it('no Glofox location at all is a quiet run: 200, stamped', async () => {
    h.seam = seam({ eligible: [] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, message: 'No locations with Glofox credentials configured.' })
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['glofox-sync', { locations_processed: 0, ...ZERO_SKIPS }]])
  })

  it('nothing eligible because credentials were unreadable answers failure (500) and still stamps', async () => {
    h.seam = seam({ eligible: [], skipped: [{ id: A.id, name: A.name, state: 'unknown', readError: SECRET_TEXT }] })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const out = await res.json()
    expect(out).toMatchObject({ success: false, locations_processed: 0, skipped_unknown: 1 })
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT)
    expect(vi.mocked(stampHeartbeat).mock.calls).toEqual([['glofox-sync', { locations_processed: 0, ...ZERO_SKIPS, skipped_unknown: 1 }]])
  })

  it('a failed seam read answers 500 with a fixed line, logs the detail and stamps nothing', async () => {
    h.seam = { locations: null, eligible: null, skipped: null, error: { message: SECRET_TEXT } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const out = await res.json()
    expect(out).toEqual({ success: false, error: 'Could not list the Glofox locations' })
    expect(logError).toHaveBeenCalledWith('cron.glofox-sync', expect.any(String), { err: { message: SECRET_TEXT } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(runs()).toHaveLength(0)
  })

  it('a throw answers the wrapper\'s fixed 500 and stamps nothing', async () => {
    vi.mocked(locationsWithSource).mockRejectedValueOnce(new Error(SECRET_TEXT))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Cron run failed' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
