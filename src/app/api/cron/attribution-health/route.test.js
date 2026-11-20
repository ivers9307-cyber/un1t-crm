// ROUTEWRAP (defineCron batch 2) — the attribution canary on the wrapper:
// 401 without the secret, a clean real run stamps, a failed section answers
// 200 (as before the wrapper) with a fixed line and no database text and does
// not stamp, and a dry run answers 200 without stamping. The sweep itself is tested in
// src/lib/hr-attribution-sweep; here it is a stub.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ fake: 'db' })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/hr-attribution-sweep', () => ({ runAttributionHealthSweep: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runAttributionHealthSweep } from '@/lib/hr-attribution-sweep'
import { GET, POST } from './route.js'

const req = (query = '', secret = 'shh') =>
  new Request(`https://x.test/api/cron/attribution-health${query}`, { headers: { authorization: `Bearer ${secret}` } })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  runAttributionHealthSweep.mockResolvedValue({ ok: true, daily: { checked: 4, breaks: [] } })
})

describe('GET /api/cron/attribution-health', () => {
  it('refuses without the secret, reading nothing and stamping nothing', async () => {
    const res = await GET(req('', 'wrong'))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(runAttributionHealthSweep).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean real run answers 200 and stamps', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, ok: true, daily: { checked: 4, breaks: [] } })
    expect(runAttributionHealthSweep).toHaveBeenCalledWith({ db: { fake: 'db' }, dry: false, forceWeekly: false })
    expect(stampHeartbeat).toHaveBeenCalledWith('attribution-health')
  })

  it('a failed read answers with a fixed line, no database text, and no stamp', async () => {
    runAttributionHealthSweep.mockResolvedValue({
      ok: false,
      daily: { error: 'contact_devices read failed: raw db text' },
      weekly: { error: 'weekly sessions read failed: raw db text' },
    })
    const res = await GET(req('?weekly=1'))
    // 200, as before the wrapper: the canary has always answered 200 here.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.daily).toEqual({ error: 'daily canary failed' })
    expect(body.weekly).toEqual({ error: 'weekly report failed' })
    expect(JSON.stringify(body)).not.toContain('raw db text')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a dry run answers 200 and does not stamp', async () => {
    const res = await GET(req('?dry=1'))
    expect(res.status).toBe(200)
    expect(runAttributionHealthSweep).toHaveBeenCalledWith({ db: { fake: 'db' }, dry: true, forceWeekly: false })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
