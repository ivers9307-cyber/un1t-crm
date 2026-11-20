// ROUTEWRAP.C5 — run-strava-exports on defineCron. The worker itself is
// src/lib/external-export.test.js; here: the secret, the stamp on a clean
// run, and a failed queue read answering 500 unstamped (it used to read as
// "nothing due" and stamp).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { GET, POST } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/run-strava-exports', { headers: { authorization: `Bearer ${secret}` } })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  db = createFakeDb({ tables: { external_export_jobs: [] } })
})

describe('GET /api/cron/run-strava-exports', () => {
  it('401s without the secret, reading nothing and stamping nothing', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a run with nothing due stamps its own row and answers the worker counts', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, ok: true, processed: 0 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('run-strava-exports')
  })

  it('POST runs the same job', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledWith('run-strava-exports')
  })

  it('a failed queue read is a failed run: 500, a fixed line, no stamp', async () => {
    db = createFakeDb({
      tables: { external_export_jobs: [] },
      errors: { external_export_jobs: { select: { message: 'relation secret_x does not exist' } } },
    })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read the export queue' })
    expect(JSON.stringify(body)).not.toContain('secret_x')
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('export-worker', expect.stringMatching(/read failed/), expect.anything())
  })
})
