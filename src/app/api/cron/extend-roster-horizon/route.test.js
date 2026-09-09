// ROSTER-FIX.5 — nightly horizon cron.
//
// Contract: CRON_SECRET or nothing happens; the heartbeat stamps only on a
// run that actually completed (a stamped heartbeat on a failed run is worse
// than no cron at all — it tells Sentinel everything is fine while the
// roster quietly stops being generated).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: vi.fn() })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/roster-horizon', () => ({ extendRosterHorizon: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { GET } from './route'
import { extendRosterHorizon } from '@/lib/roster-horizon'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/extend-roster-horizon', {
    headers: { authorization: `Bearer ${secret}` },
  })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  extendRosterHorizon.mockResolvedValue({ templates: 4, inserted: 12, skipped: 100, failed: 0 })
})

describe('auth', () => {
  it('401s on a wrong secret and does no work', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(extendRosterHorizon).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset — never open by omission', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req('shh'))
    expect(res.status).toBe(401)
    expect(extendRosterHorizon).not.toHaveBeenCalled()
  })
})

describe('run', () => {
  it('extends the horizon and stamps the heartbeat with the outcome', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, stats: { templates: 4, inserted: 12, failed: 0 } })
    expect(stampHeartbeat).toHaveBeenCalledWith('extend-roster-horizon', expect.objectContaining({ inserted: 12 }))
  })

  it('500s and does NOT stamp when the sweep throws', async () => {
    extendRosterHorizon.mockRejectedValue(new Error('boom'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
