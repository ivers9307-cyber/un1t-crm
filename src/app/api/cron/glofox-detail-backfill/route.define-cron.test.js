// ROUTEWRAP.C11 — glofox-detail-backfill on defineCron: the wrapper owns the secret check, the
// error boundary and the stamp. A failed studio withholds the stamp
// (GLOFOX414.1); a run where no studio completed answers 500, and no database
// text leaves in the response.
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
  fetchMemberResult: vi.fn(async () => ({ ok: true, member: null })),
}))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { locationsWithSource } from '@/lib/membership/locations-for-source'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { GET } from './route.js'

const LOC_A = { id: 'a0000000-0000-0000-0000-000000000001', name: 'Studio A', state: 'configured' }
const LOC_B = { id: 'b0000000-0000-0000-0000-000000000002', name: 'Studio B', state: 'configured' }
const DB_TEXT = 'canceling statement due to statement timeout on db.internal'
const req = (auth = 'Bearer shh') => new Request('https://x.test/api/cron/glofox-detail-backfill', { headers: auth ? { authorization: auth } : {} })

let db
function setup(errors) {
  db = createFakeDb({ tables: { glofox_sync_runs: [], contacts: [] }, errors })
  createServerClient.mockImplementation(() => db)
}
beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  setup()
  locationsWithSource.mockResolvedValue({ eligible: [LOC_A], skipped: [], error: null })
})

describe('GET /api/cron/glofox-detail-backfill — defineCron', () => {
  it('refuses a caller without the secret, and every caller when the secret is unset: nothing read or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req('Bearer undefined'))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
    expect(db.calls).toEqual([])
    expect(locationsWithSource).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run with nothing to do stamps exactly its own row, once', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, locations_processed: 1 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls[0][0]).toBe('glofox-detail-backfill')
    expect(db.tables.glofox_sync_runs[0]).toMatchObject({ status: 'completed' })
  })

  it('a failed seam read answers 500 with a fixed line and stamps nothing', async () => {
    locationsWithSource.mockResolvedValue({ eligible: null, skipped: null, error: { message: DB_TEXT } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the Glofox studios' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('the only studio failing answers 500, keeps the database text out of the response, and stamps nothing', async () => {
    setup({ contacts: { select: { message: DB_TEXT } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('statement timeout')
    expect(JSON.parse(text).per_location[0]).toMatchObject({ status: 'failed', first_error: 'Location run failed' })
    expect(db.tables.glofox_sync_runs[0]).toMatchObject({ status: 'failed', first_error: DB_TEXT })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('one of two studios failing answers success:false at 200 and stamps nothing (as before)', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [LOC_A, LOC_B], skipped: [], error: null })
    const { glofoxCredentialsForLocation } = await import('@/lib/glofox')
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out).toMatchObject({ success: false, locations_processed: 2 })
    expect(out.per_location[0]).toMatchObject({ status: 'failed', first_error: 'Glofox credentials missing on this location.' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable only studio is a failed run, not an idle one: 500 and no stamp', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [], skipped: [{ ...LOC_A, state: 'unknown', readError: DB_TEXT }], error: null })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('statement timeout')
    expect(JSON.parse(text)).toMatchObject({ success: false, skipped_unknown: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('no Glofox studio at all is a healthy idle run and stamps', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [], skipped: [{ ...LOC_B, state: 'unconfigured' }], error: null })
    expect((await GET(req())).status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })
})

describe('GET /api/cron/glofox-detail-backfill — unknown beside a completed studio (unchanged)', () => {
  it('withholds the stamp and answers success:false at 200', async () => {
    locationsWithSource.mockResolvedValue({ eligible: [LOC_A], skipped: [{ ...LOC_B, state: 'unknown', readError: DB_TEXT }], error: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('statement timeout')
    expect(JSON.parse(text).success).toBe(false)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
