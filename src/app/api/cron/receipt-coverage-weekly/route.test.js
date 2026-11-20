// CRONWRAP — the weekly receipt-coverage pull on defineCron. Its own row,
// 'receipt-coverage-weekly', is stamped by process-receipt-hunts' finalizer,
// never here: every path answers with `stamp: false`. Pinned: 401 without the
// secret (no reads), a quiet tick, a clean slot tick, a failed connections
// read, a faulted claim and a studio whose pull throws (fixed text out, the
// detail logged). The daily-slot gate itself is covered by
// ../daily-slot-location-crons.tz6.test.js; here it is stubbed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ gate: null }))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/recon/pull', () => ({ runCoveragePull: vi.fn(async () => ({ anomalies: [] })) }))
vi.mock('@/lib/recon/statuses', () => ({
  sweepSubmittedLines: vi.fn(async () => ({ flagged: 1 })),
  seedHunts: vi.fn(async () => ({ seeded: 2 })),
}))
vi.mock('@/lib/cron-daily-slot', async (importOriginal) => ({
  ...(await importOriginal()),
  gateDailySlot: vi.fn(async () => h.gate),
}))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { runCoveragePull } from '@/lib/recon/pull'
import { gateDailySlot } from '@/lib/cron-daily-slot'
import { openGateOn } from '@/lib/cron-daily-slot.test-helpers'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { GET } from './route.js'

const LOC_A = 'a0000000-0000-4000-8000-000000000001'
const LOC_B = 'a0000000-0000-4000-8000-000000000002'
const req = (secret = 'shh') => new Request('https://x.test/api/cron/receipt-coverage-weekly', { headers: { authorization: `Bearer ${secret}` } })
const QUIET = { ok: true, faulted: false, slots: new Map(), summary: { due: 0 } }

let db
function setup({ errors } = {}) {
  db = createFakeDb({
    tables: {
      locations: [{ id: LOC_A, name: 'Studio A' }, { id: LOC_B, name: 'Studio B' }],
      xero_connections: [{ location_id: LOC_A }, { location_id: LOC_B }],
      recon_runs: [],
    },
    errors,
  })
  createServerClient.mockImplementation(() => db)
}

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  h.gate = await openGateOn('2026-07-03')()
  setup()
})

describe('GET /api/cron/receipt-coverage-weekly', () => {
  it('refuses without the secret: no reads, no stamp', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(gateDailySlot).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a quiet tick answers success, skipped, and stamps nothing', async () => {
    h.gate = QUIET
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, skipped: true, slot: { due: 0 } })
    expect(runCoveragePull).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean slot tick pulls, sweeps and seeds every connected studio and still stamps nothing (the finalizer owns the row)', async () => {
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: {
        locations: 2,
        perLocation: [
          { locationName: 'Studio A', seeded: 2, flagged: 1, anomalies: 0 },
          { locationName: 'Studio B', seeded: 2, flagged: 1, anomalies: 0 },
        ],
        errors: [],
      },
    })
    expect(runCoveragePull.mock.calls.map(([, id, o]) => [id, o])).toEqual([[LOC_A, { trigger: 'cron' }], [LOC_B, { trigger: 'cron' }]])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable connections list answers 500 with fixed text and stamps nothing', async () => {
    setup({ errors: { xero_connections: { select: { message: 'permission denied for table xero_connections' } } } })
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body).toEqual({ success: false, error: 'Could not read the Xero connections' })
    expect(logError).toHaveBeenCalledWith('receipt-coverage-weekly', 'connections load failed', { err: 'permission denied for table xero_connections' })
    expect(runCoveragePull).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('unreadable zones or a faulted claim answer 500 and stamp nothing', async () => {
    h.gate = { ok: false, faulted: true, slots: new Map(), summary: { due: 0 } }
    let res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'locations unreadable' })

    h.gate = { ok: true, faulted: true, slots: new Map(), summary: { due: 0 } }
    res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, skipped: true, slot: { due: 0 } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a studio whose pull throws is reported by name with fixed text (success false, still 200, as before) and the rest still run', async () => {
    runCoveragePull.mockImplementation(async (_db, id) => {
      if (id === LOC_A) throw new Error('Xero said: token expired for tenant 1234')
      return { anomalies: [] }
    })
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(false)
    expect(body.data.errors).toEqual([{ locationName: 'Studio A', error: 'pull failed' }])
    expect(body.data.perLocation.map((p) => p.locationName)).toEqual(['Studio B'])
    expect(JSON.stringify(body)).not.toContain('token expired')
    expect(logError).toHaveBeenCalledWith('receipt-coverage-weekly', 'pull failed', expect.objectContaining({ locationName: 'Studio A' }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
