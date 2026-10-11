// CRONREADERR.1 — the class-sync route counts a location whose reconcile step
// failed (reconcile_errors), carries on to the next studio, and stamps as
// before: the row watches the cron, not Glofox or one studio's read (C2). Its
// own file so C3's route.test.js (TRAINERCALLS.1) is not a shared hunk.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let locationsResult = { data: [], error: null }
const fakeDb = {
  from: () => {
    const b = {}
    for (const m of ['select', 'filter', 'eq', 'in', 'order', 'range']) b[m] = () => b
    // W1.M3b — the seam's per-location state read (locations.membership_source by id).
    b.maybeSingle = async () => (locationsResult.error ? locationsResult : { data: locationsResult.data?.[0] ?? null, error: null })
    b.then = (resolve, reject) => Promise.resolve(locationsResult).then(resolve, reject)
    return b
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: (c) => [['branchId', 'Branch ID'], ['apiKey', 'API Key'], ['apiToken', 'API Token']].filter(([k]) => !c?.[k]).map(([, l]) => l),
}))
vi.mock('@/lib/class-occurrences', () => ({ syncOccurrencesForLocation: vi.fn() }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncOccurrencesForLocation } from '@/lib/class-occurrences'

const loc = (n) => ({
  id: `a0000000-0000-0000-0000-00000000000${n}`,
  name: `Studio ${n}`,
  active: true,
  membership_source: 'glofox',
  settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } },
})
const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  locationsResult = { data: [loc(1), loc(2)], error: null }
})

describe('GET /api/cron/sync-class-occurrences — reconcile errors (CRONREADERR.1)', () => {
  it('one studio\'s failed reconcile is counted, the other studio still syncs, and the tick stamps', async () => {
    syncOccurrencesForLocation
      .mockResolvedValueOnce({ ok: true, upserted: 3, cancelled: 0, reconcileFailed: true })
      .mockResolvedValueOnce({ ok: true, upserted: 4, cancelled: 1, reconcileFailed: false })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(syncOccurrencesForLocation).toHaveBeenCalledTimes(2)
    expect(body.stats).toMatchObject({ locations: 2, upserted: 7, errors: 0, reconcile_errors: 1 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('a clean tick reports reconcile_errors: 0', async () => {
    syncOccurrencesForLocation.mockResolvedValue({ ok: true, upserted: 1, cancelled: 0, reconcileFailed: false })
    const body = await (await GET(req())).json()
    expect(body.stats.reconcile_errors).toBe(0)
  })
})
