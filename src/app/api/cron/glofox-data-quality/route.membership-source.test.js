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
import { ESTATE_2026_10, ESTATE_2026_10_17, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

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

  it('UN1TCAP.1 — Hatch on un1t.online (configured, no data) is still skipped: evaluates Stillorgan only, counts the five skips, stamps tenant + global', async () => {
    h.db = dbFor(ESTATE_2026_10_17)
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

// UN1TRADAR.3 — the check reads Glofox pack-sync freshness, so it visits
// Glofox-source locations only, whatever capability another source gains.
describe('GET /api/cron/glofox-data-quality — Glofox sources only (UN1TRADAR.3)', () => {
  it('glofox-data-quality skips non-Glofox sources (lists by membership_source = glofox)', async () => {
    h.db = dbFor(ESTATE_2026_10_17)
    await GET(req())
    const listed = queriesOf(h.db, 'locations').filter((q) => q.eq.membership_source)
    expect(listed.map((q) => q.eq.membership_source)).toEqual(['glofox'])
    expect(queriesOf(h.db, 'contacts').map((q) => q.eq.location_id)).toEqual([STILLORGAN_ID])
  })
})

// ROUTEWRAP.C7 — the job runs inside defineCron: the wrapper owns the secret
// check, the error boundary and the global stamp.
describe('GET /api/cron/glofox-data-quality — defineCron', () => {
  const reqAs = (auth) => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })

  it('refuses a caller without the cron secret: nothing read, nothing stamped', async () => {
    h.db = dbFor(ESTATE_2026_10)
    for (const auth of [null, 'Bearer nope']) expect((await GET(reqAs(auth))).status).toBe(401)
    expect(h.db.queries).toHaveLength(0)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(stampTenantHeartbeat).not.toHaveBeenCalled()
  })

  it('a fresh run stamps exactly the global row, once (tenant rows are its own helper)', async () => {
    h.db = dbFor(ESTATE_2026_10)
    expect((await GET(req())).status).toBe(200)
    expect(stampHeartbeat.mock.calls).toEqual([['glofox-data-quality']])
  })

  it('a stale run still answers success but withholds the global stamp', async () => {
    const loc = locationsResolver(ESTATE_2026_10)
    h.db = fakeDb((q) => (q.table === 'locations' ? loc(q) : { data: { glofox_synced_at: '2020-01-01T00:00:00Z' }, error: null }))
    const out = await (await GET(req())).json()
    expect(out).toMatchObject({ success: true, healthy: false })
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed locations read answers a fixed line with no database text and stamps nothing', async () => {
    h.db = fakeDb((q) => (q.table === 'locations' && !q.eq.membership_source
      ? { data: null, error: { message: 'permission denied for table locations' } }
      : locationsResolver(ESTATE_2026_10)(q)))
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read locations' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed seam read answers a fixed line with no database text', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'connection reset by db.internal' } })
    const body = await (await GET(req())).json()
    expect(body).toEqual({ success: false, error: 'Could not read membership sources' })
  })

  it('a failed pack-sync read answers a fixed line and stamps no global row', async () => {
    const loc = locationsResolver(ESTATE_2026_10)
    h.db = fakeDb((q) => (q.table === 'locations' ? loc(q) : { data: null, error: { message: 'statement timeout on contacts' } }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read pack-sync freshness' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
