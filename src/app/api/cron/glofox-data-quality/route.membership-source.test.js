// W1.M3b — the pack-credit freshness check skips locations with NO membership
// source (counted skipped_no_source) through the seam; a failed seam read is a
// 500 with no heartbeat.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/tenant-heartbeat', () => ({ stampTenantHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: vi.fn(async () => {}) }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { stampTenantHeartbeat } from '@/lib/tenant-heartbeat'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
// Every location answers a FRESH pack sync, so only the seam decides who is evaluated.
const dbFor = (rows, opts) => {
  const loc = locationsResolver(rows, opts)
  return fakeDb((q) => (q.table === 'locations' ? loc(q) : { data: { glofox_synced_at: new Date().toISOString() }, error: null }))
}
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/glofox-data-quality — skips locations with no membership source (W1.M3b)', () => {
  it('evaluates Stillorgan only, counts the five skips, stamps tenant + global', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(queriesOf(h.db, 'contacts').map((q) => q.eq.location_id)).toEqual([STILLORGAN_ID])
    expect(stampTenantHeartbeat.mock.calls.map(([, id]) => id)).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, healthy: true, skipped_no_source: 5 })
    expect(out.locations.map((l) => l.location_id)).toEqual([STILLORGAN_ID])
    expect(sendOpsAlert).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-data-quality')
  })
  it('a failed seam read answers 500 and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'down' } })
    expect((await GET(req())).status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(stampTenantHeartbeat).not.toHaveBeenCalled()
  })
})
