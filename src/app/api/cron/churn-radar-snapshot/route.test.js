// RADAR-TREND.1 — the weekly churn-radar snapshot on defineCron: the secret
// gate, the one stamp on a clean run, and fixed text on every failure (the
// discovery seam has its own file, route.membership-source.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn(async () => ({ summary: { activeBase: 3, atRisk: 1 } })) }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadRadar } from '@/lib/churn-radar-data'
import { logError, logWarn } from '@/lib/log'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const req = (auth = 'Bearer test-secret') => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })
const dbFor = (rows, { activeError = null, insertError = null } = {}) => {
  const loc = locationsResolver(rows)
  return fakeDb((q) => {
    if (q.table === 'locations' && activeError && q.eq.active === true) return { data: null, error: activeError }
    if (q.table === 'locations') return loc(q)
    if (q.table === 'churn_radar_snapshots' && insertError) return { data: null, error: insertError }
    return { data: null, error: null }
  })
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.db = dbFor(ESTATE_2026_10)
})

describe('GET /api/cron/churn-radar-snapshot', () => {
  it('refuses a caller without the cron secret: nothing read, nothing stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    expect(h.db.queries).toEqual([])
    expect(loadRadar).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run writes the snapshot and stamps its own row exactly once, with no outcome', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, locations: 1, snapshots_written: 1 })
    expect(queriesOf(h.db, 'churn_radar_snapshots', 'insert')[0].payload[0]).toMatchObject({ location_id: STILLORGAN_ID, active_base: 3, at_risk: 1 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('churn-radar-snapshot')
  })

  it('one location failing is a fixed per-location error, logged, and the run still stamps', async () => {
    loadRadar.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'))
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ success: true, snapshots_written: 0 })
    expect(body.perLocation).toEqual([{ location_id: STILLORGAN_ID, location_name: expect.any(String), ok: false, error: 'radar failed' }])
    expect(JSON.stringify(body)).not.toContain('statement timeout')
    expect(logWarn).toHaveBeenCalledWith('cron-churn-radar-snapshot', 'radar failed for location', { locationId: STILLORGAN_ID, err: 'canceling statement due to statement timeout' })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('a failed locations read answers 500 with a fixed error and stamps nothing', async () => {
    h.db = dbFor(ESTATE_2026_10, { activeError: { message: 'permission denied for table locations' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not list locations' })
    expect(logError).toHaveBeenCalledWith('cron-churn-radar-snapshot', 'failed to list locations', { err: 'permission denied for table locations' })
    expect(loadRadar).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed snapshot insert answers 500 with a fixed error and stamps nothing', async () => {
    h.db = dbFor(ESTATE_2026_10, { insertError: { message: 'duplicate key value violates unique constraint' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not write the snapshots' })
    expect(logError).toHaveBeenCalledWith('cron-churn-radar-snapshot', 'snapshot insert failed', { err: 'duplicate key value violates unique constraint', rows: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
