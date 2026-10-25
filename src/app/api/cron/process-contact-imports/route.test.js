// CRONREADERR.1 — the contact-import drain. A failed pending-job read is not
// "no work": 500, nothing claimed, no stamp (the job stays pending for the
// next */2 tick and the QStash worker; mig 644's 120 + 240 absorbs one missed
// tick). A failed stuck-job reset is this tick's own fault: logged, counted,
// no stamp, but the pending job still runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let recoverResult = { data: [], error: null }
let pendingResult = { data: [], error: null }

function builder(table) {
  const b = { op: 'select' }
  for (const m of ['select', 'eq', 'lt', 'order', 'limit']) b[m] = () => b
  b.update = () => { b.op = 'update'; return b }
  b.then = (resolve, reject) => {
    let out = { data: null, error: null }
    if (table === 'contact_imports') out = b.op === 'update' ? recoverResult : pendingResult
    return Promise.resolve(out).then(resolve, reject)
  }
  return b
}
const fakeDb = { from: (t) => builder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/contact-import-queue', () => ({ claimAndProcessImportJob: vi.fn(), STUCK_AFTER_MINUTES: 5 }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { claimAndProcessImportJob } from '@/lib/contact-import-queue'

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const ERR = { message: 'fetch failed' }
const JOB = { id: 'imp-1', status: 'pending' }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  recoverResult = { data: [], error: null }
  pendingResult = { data: [], error: null }
  claimAndProcessImportJob.mockResolvedValue({ status: 'processed' })
})

describe('GET /api/cron/process-contact-imports — read errors (CRONREADERR.1)', () => {
  it('a failed pending-job read: 500, nothing claimed, heartbeat NOT stamped, logged', async () => {
    pendingResult = { data: null, error: ERR }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(claimAndProcessImportJob).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'cron-process-contact-imports',
      'pending-job read failed; nothing claimed, heartbeat not stamped',
      expect.objectContaining({ err: ERR }),
    )
  })

  it('a failed stuck-job reset with an empty queue: 200, recover_failed 1, NOT stamped, logged', async () => {
    recoverResult = { data: null, error: ERR }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ recover_failed: 1, recovered: 0, skipped_no_work: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'cron-process-contact-imports',
      'stuck-job reset failed; heartbeat not stamped this tick',
      expect.objectContaining({ err: ERR }),
    )
  })

  it('a failed stuck-job reset does not hold the pending job hostage: it is still processed, but not stamped', async () => {
    recoverResult = { data: null, error: ERR }
    pendingResult = { data: [JOB], error: null }
    const body = await (await GET(req())).json()
    expect(claimAndProcessImportJob).toHaveBeenCalledWith(fakeDb, JOB)
    expect(body.data).toMatchObject({ processed: 1, recover_failed: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean empty tick stamps, with recover_failed 0 in the outcome', async () => {
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledWith('process-contact-imports', {
      processed: 0, recovered: 0, failed: 0, skipped: 0, skipped_no_work: 1, recover_failed: 0,
    })
  })

  it('recovered rows are counted and a processed job stamps (unchanged)', async () => {
    recoverResult = { data: [{ id: 'a' }, { id: 'b' }], error: null }
    pendingResult = { data: [JOB], error: null }
    const body = await (await GET(req())).json()
    expect(body.data).toMatchObject({ recovered: 2, processed: 1 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })
})
