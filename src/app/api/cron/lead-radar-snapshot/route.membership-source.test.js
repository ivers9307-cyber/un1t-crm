// W1.M3b — the lead-radar snapshot skips locations with NO membership source
// (counted skipped_no_source) through the seam; a failed seam read is a 500
// with no heartbeat.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/lead-radar-data', () => ({ loadFunnel: vi.fn(async () => ({ summary: { funnelTotal: 2, funnel: {} } })) }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadFunnel } from '@/lib/lead-radar-data'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const dbFor = (rows, opts) => { const loc = locationsResolver(rows, opts); return fakeDb((q) => (q.table === 'locations' ? loc(q) : { data: null, error: null })) }
const visited = () => loadFunnel.mock.calls.map(([, id]) => id)
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/lead-radar-snapshot — skips locations with no membership source (W1.M3b)', () => {
  it('snapshots Stillorgan only, counts the five skips, writes one row, stamps', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, locations: 1, skipped_no_source: 5, snapshots_written: 1 })
    expect(queriesOf(h.db, 'lead_radar_snapshots', 'insert')[0].payload.map((r) => r.location_id)).toEqual([STILLORGAN_ID])
    expect(stampHeartbeat).toHaveBeenCalledWith('lead-radar-snapshot')
  })
  it('a failed seam read answers 500 and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'down' } })
    expect((await GET(req())).status).toBe(500)
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
