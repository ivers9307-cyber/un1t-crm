// ROUTEWRAP.C11 — the full booking-history read on defineCron: the wrapper owns
// the secret check, the error boundary and the stamp. A failed studio withholds
// the stamp (GLOFOX414.1); a run where no studio completed answers 500, and no
// database text leaves in the response.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/membership/locations-for-source', async (importOriginal) => ({
  ...(await importOriginal()),
  locationsWithSource: vi.fn(),
}))
vi.mock('@/lib/glofox-crossover', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCrossoverContactIds: vi.fn(async () => ({ ids: [] })),
}))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })),
  fetchUserBookingHistoryResult: vi.fn(async () => ({ ok: true, bookings: [], truncated: false })),
}))
vi.mock('@/lib/glofox-attendance-history', async (importOriginal) => ({
  ...(await importOriginal()),
  listHistoryCandidates: vi.fn(async () => []),
  countHistoryRemaining: vi.fn(async () => 0),
}))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { listHistoryCandidates } from '@/lib/glofox-attendance-history'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { GET } from './route.js'

const LOC_A = { id: 'a0000000-0000-0000-0000-000000000001', name: 'Studio A', state: 'configured' }
const LOC_B = { id: 'b0000000-0000-0000-0000-000000000002', name: 'Studio B', state: 'configured' }
const DB_TEXT = 'relation "contacts" statement timeout on db.internal'
const req = (auth = 'Bearer shh') => new Request('https://x.test/api/cron/glofox-attendance-history', { headers: auth ? { authorization: auth } : {} })

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  db = createFakeDb({ tables: { glofox_sync_runs: [], contacts: [] } })
  createServerClient.mockImplementation(() => db)
  locationsWithSource.mockResolvedValue({ eligible: [LOC_A], skipped: [], error: null })
})

describe('GET /api/cron/glofox-attendance-history — defineCron', () => {
  it('refuses a caller without the secret, and every caller when the secret is unset: nothing read or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req('Bearer undefined'))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
    expect(db.calls).toEqual([])
    expect(locationsWithSource).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run with nothing pending stamps exactly its own row, once', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, locations_processed: 1 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls[0][0]).toBe('glofox-attendance-history')
  })

  it('a failed seam read answers 500 with a fixed line and stamps nothing', async () => {
    locationsWithSource.mockResolvedValue({ eligible: null, skipped: null, error: { message: DB_TEXT } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the Glofox studios' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('the only studio failing answers 500, keeps the database text out of the response, and stamps nothing', async () => {
    listHistoryCandidates.mockRejectedValueOnce(new Error(DB_TEXT))
    const res = await GET(req())
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('statement timeout')
    expect(JSON.parse(text).per_location[0]).toMatchObject({ status: 'failed', error: 'Location run failed' })
    expect(db.tables.glofox_sync_runs[0]).toMatchObject({ status: 'failed', first_error: DB_TEXT })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('one of two studios failing answers success:false at 200 and stamps nothing (as before)', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [LOC_A, LOC_B], skipped: [], error: null })
    listHistoryCandidates.mockRejectedValueOnce(new Error(DB_TEXT))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: false, locations_processed: 2 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable only studio is a failed run, not an idle one: 500 and no stamp (was a clean stamp)', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [], skipped: [{ ...LOC_A, state: 'unknown', readError: DB_TEXT }], error: null })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('statement timeout')
    expect(JSON.parse(text)).toMatchObject({ success: false, skipped_unknown: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable studio beside one that completed still stamps, with the skip counted (unchanged)', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [LOC_A], skipped: [{ ...LOC_B, state: 'unknown' }], error: null })
    expect((await GET(req())).status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls[0][1]).toMatchObject({ skipped_unknown: 1 })
  })

  it('no Glofox studio at all is a healthy idle run and stamps', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [], skipped: [{ ...LOC_B, state: 'unconfigured' }], error: null })
    expect((await GET(req())).status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })
})
