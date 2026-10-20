// LIEU.1 — nightly lieu-credit cron: CRON_SECRET or nothing happens; the
// heartbeat stamps only on a sweep that read the estate (ok: true), never on
// a throw or a failed sweep; `?days=` widens the window for a backfill.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: vi.fn() })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/lieu-credits', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, runLieuCreditSweep: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { GET } from './route'
import { runLieuCreditSweep } from '@/lib/lieu-credits'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const req = (secret = 'shh', qs = '') =>
  new Request(`https://x.test/api/cron/lieu-credits${qs}`, { headers: { authorization: `Bearer ${secret}` } })

const OK = { ok: true, locations: 2, candidates: 3, inserted: 2, skipped_existing: 1, skipped_not_ended: 0, failed: 0, failures: [] }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  runLieuCreditSweep.mockResolvedValue(OK)
})

describe('auth', () => {
  it('401s on a wrong secret and does no work', async () => {
    expect((await GET(req('wrong'))).status).toBe(401)
    expect(runLieuCreditSweep).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
  it('401s when CRON_SECRET is unset — never open by omission', async () => {
    delete process.env.CRON_SECRET
    expect((await GET(req('shh'))).status).toBe(401)
    expect(runLieuCreditSweep).not.toHaveBeenCalled()
  })
})

describe('run', () => {
  it('sweeps the default window and stamps the heartbeat with the outcome', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, stats: OK })
    expect(runLieuCreditSweep).toHaveBeenCalledWith(expect.anything(), { lookbackDays: 14 })
    expect(stampHeartbeat).toHaveBeenCalledWith('lieu-credits', OK)
  })
  it('?days= widens the window within 1..400; anything else is a 400 before any work', async () => {
    await GET(req('shh', '?days=120'))
    expect(runLieuCreditSweep).toHaveBeenCalledWith(expect.anything(), { lookbackDays: 120 })
    for (const bad of ['0', '401', '1.5', 'x']) {
      vi.clearAllMocks()
      expect((await GET(req('shh', `?days=${bad}`))).status).toBe(400)
      expect(runLieuCreditSweep).not.toHaveBeenCalled()
    }
  })
  it('a partial failure still stamps (it rides in last_outcome)', async () => {
    const partial = { ...OK, failed: 1, failures: [{ location_id: 'b', step: 'shifts', error: 'down' }] }
    runLieuCreditSweep.mockResolvedValue(partial)
    expect((await GET(req())).status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledWith('lieu-credits', partial)
  })
  it('a failed sweep (ok: false) is a 500 with no stamp', async () => {
    runLieuCreditSweep.mockResolvedValue({ ...OK, ok: false, error: 'Every studio failed', failed: 2 })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Every studio failed')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
  it('a throw is a 500 with no stamp', async () => {
    runLieuCreditSweep.mockRejectedValue(new Error('boom'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
