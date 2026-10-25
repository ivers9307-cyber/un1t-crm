// ORGCONTACTS.1 (plan Task 10) — the nightly contact_studios reconcile cron:
//   1. 401 without CRON_SECRET;
//   2. one call of public.reconcile_contact_studios(NULL); its counts are the
//      heartbeat outcome and the response;
//   3. a failed RPC is a 500 with NO heartbeat (never "healthy");
//   4. ORGCONTACTS.8: the run time (duration_ms) rides on the heartbeat and the
//      response, and a run past SLOW_RUN_MS warns.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ rpc: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ rpc: (...args) => h.rpc(...args) }) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { GET, CRON_NAME, SLOW_RUN_MS } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'

const req = (token = 'test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
})
const COUNTS = { inserted: 2, updated: 5, ended: 1, unchanged: 900, skipped_no_primary: 3 }

// clockTaking(ms): the RPC advances the faked Date.now() by ms, so the route measures exactly that.
function clockTaking(ms) {
  let t = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => t)
  h.rpc = vi.fn(async () => { t += ms; return { data: [COUNTS], error: null } })
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.restoreAllMocks()
  vi.clearAllMocks()
  clockTaking(1234)
})

describe('GET /api/cron/contact-studios-reconcile', () => {
  it('is 401 without the secret and calls nothing', async () => {
    const res = await GET(req(null))
    expect(res.status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('reconciles everything, stamps the heartbeat with the counts, returns them', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('reconcile_contact_studios', { p_location_id: null })
    expect(CRON_NAME).toBe('contact-studios-reconcile')
    expect(stampHeartbeat).toHaveBeenCalledWith('contact-studios-reconcile', { ...COUNTS, duration_ms: 1234 })
    expect(await res.json()).toEqual({ success: true, ...COUNTS, duration_ms: 1234 })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a run past half its time limit still stamps, and warns', async () => {
    expect(SLOW_RUN_MS).toBe(150_000)
    clockTaking(SLOW_RUN_MS + 1)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledWith('contact-studios-reconcile', expect.objectContaining({ duration_ms: SLOW_RUN_MS + 1 }))
    expect(logWarn).toHaveBeenCalledWith('contact-studios-reconcile', expect.any(String), expect.objectContaining({ duration_ms: SLOW_RUN_MS + 1, limit_ms: 300_000 }))
  })

  it('a run at exactly half its limit does not warn', async () => {
    clockTaking(SLOW_RUN_MS)
    await GET(req())
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a failed RPC is a 500 and never stamps', async () => {
    h.rpc = vi.fn(async () => ({ data: null, error: { message: 'boom', code: '42P01' } }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('contact-studios-reconcile', expect.any(String), expect.objectContaining({ code: '42P01', duration_ms: 0 }))
  })
})
