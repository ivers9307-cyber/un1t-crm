// TRAINERCALLS.1 — the class-sync cron stamps its heartbeat WITH the run's
// stats as last_outcome (CLASSSYNCHB.1 open question 3a): trainer_api_calls
// is how the once-a-day trainer lookup is verified in prod (0 on every tick
// but the 04:00 Dublin one) without calling Glofox. What STALE means is
// unchanged: the stamp is unconditional after the loop, so a tick where
// Glofox ANSWERS with an error still stamps and does not page; a Glofox that
// HANGS or RATE-LIMITS past the 60 s maxDuration kills the tick before its
// stamp, so that does page (mig 644's note).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

let locationsResult = { data: [], error: null }
const fakeDb = {
  from: () => {
    const b = {}
    for (const m of ['select', 'filter']) b[m] = () => b
    b.then = (resolve) => Promise.resolve(locationsResult).then(resolve)
    return b
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
}))
vi.mock('@/lib/class-occurrences', () => ({ syncOccurrencesForLocation: vi.fn() }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncOccurrencesForLocation } from '@/lib/class-occurrences'

const LOC = {
  id: 'a0000000-0000-0000-0000-000000000001',
  name: 'Studio',
  settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } },
}
const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  locationsResult = { data: [LOC], error: null }
})

describe('GET /api/cron/sync-class-occurrences', () => {
  it('stamps the heartbeat with the run\'s stats, trainer API calls included', async () => {
    syncOccurrencesForLocation.mockResolvedValue({
      ok: true, upserted: 15, cancelled: 0, seen: 15, trainersMapped: 0, trainerLookup: 'skipped', trainerApiCalls: 0,
    })
    const res = await GET(req())
    const body = await res.json()
    const stats = { locations: 1, upserted: 15, errors: 0, trainer_api_calls: 0, reconcile_errors: 0 }
    expect(body).toEqual({ success: true, stats })
    expect(stampHeartbeat).toHaveBeenCalledWith('sync-class-occurrences', stats)
  })

  it('counts the trainer calls of a failed sync too (the upsert failed after the daily lookup)', async () => {
    syncOccurrencesForLocation.mockResolvedValue({
      ok: false, error: 'upsert failed', upserted: 0, trainerLookup: 'daily', trainerApiCalls: 5,
    })
    const body = await (await GET(req())).json()
    expect(body.stats).toEqual({ locations: 1, upserted: 0, errors: 1, trainer_api_calls: 5, reconcile_errors: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('sync-class-occurrences', body.stats)
  })

  it('a Glofox-down tick (events fetch failed) still stamps, with 0 trainer calls', async () => {
    syncOccurrencesForLocation.mockResolvedValue({ ok: false, error: 'HTTP 502', upserted: 0 })
    const body = await (await GET(req())).json()
    expect(body.stats).toEqual({ locations: 1, upserted: 0, errors: 1, trainer_api_calls: 0, reconcile_errors: 0 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('a failed locations read answers 500 and does not stamp (unchanged)', async () => {
    locationsResult = { data: null, error: { message: 'boom' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(syncOccurrencesForLocation).not.toHaveBeenCalled()
  })

  it('refuses a caller without the cron secret (unchanged)', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('the daily trainer lookup needs a tick inside [04:00, 04:15) Dublin', () => {
  it('vercel.json still runs the class sync every 15 minutes', () => {
    const vercel = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../../../vercel.json'), 'utf8'))
    const schedules = vercel.crons
      .filter((c) => c.path === '/api/cron/sync-class-occurrences')
      .map((c) => c.schedule)
    expect(
      schedules,
      'isTrainerLookupTick (src/lib/class-occurrences.js) assumes exactly one tick lands in [04:00, 04:15) Dublin. ' +
        'A new schedule must still put one there (or move the window), and re-size the cron_heartbeats row in a new migration (CLASSSYNCHB.1).',
    ).toEqual(['*/15 * * * *'])
  })
})

describe('GET /api/cron/sync-class-occurrences — REGISTRYREAD.1b unreadable settings', () => {
  it('skips the Glofox call for that studio, counts an error, logs it, still stamps; the next studio still syncs', async () => {
    const { glofoxCredentialsForLocation } = await import('@/lib/glofox')
    const { logWarn } = await import('@/lib/log')
    const LOC2 = { ...LOC, id: 'a0000000-0000-0000-0000-000000000002', name: 'Studio 2' }
    locationsResult = { data: [LOC, LOC2], error: null }
    glofoxCredentialsForLocation
      .mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
      .mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
    syncOccurrencesForLocation.mockResolvedValue({ ok: true, upserted: 4, trainerApiCalls: 0 })

    const body = await (await GET(req())).json()
    expect(syncOccurrencesForLocation).toHaveBeenCalledTimes(1)
    expect(syncOccurrencesForLocation.mock.calls[0][1]).toMatchObject({ locationId: LOC2.id })
    const stats = { locations: 2, upserted: 4, errors: 1, trainer_api_calls: 0, reconcile_errors: 0 }
    expect(body).toEqual({ success: true, stats })
    expect(logWarn).toHaveBeenCalledWith('cron-sync-class-occurrences', expect.stringContaining('unreadable'), { locationId: LOC.id })
    expect(stampHeartbeat).toHaveBeenCalledWith('sync-class-occurrences', stats)
  })
})
