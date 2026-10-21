// ORGCONTACTS.1 (plan Task 10) — the nightly contact_studios reconcile cron:
//   1. 401 without CRON_SECRET;
//   2. one call of public.reconcile_contact_studios(NULL); its counts are the
//      heartbeat outcome and the response;
//   3. a failed RPC is a 500 with NO heartbeat (never "healthy").
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ rpc: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ rpc: (...args) => h.rpc(...args) }) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { GET, CRON_NAME } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'

const req = (token = 'test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
})
const COUNTS = { inserted: 2, updated: 5, ended: 1, unchanged: 900, skipped_no_primary: 3 }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.rpc = vi.fn(async () => ({ data: [COUNTS], error: null }))
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
    expect(stampHeartbeat).toHaveBeenCalledWith('contact-studios-reconcile', COUNTS)
    expect(await res.json()).toEqual({ success: true, ...COUNTS })
  })

  it('a failed RPC is a 500 and never stamps', async () => {
    h.rpc = vi.fn(async () => ({ data: null, error: { message: 'boom', code: '42P01' } }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('contact-studios-reconcile', expect.any(String), expect.objectContaining({ code: '42P01' }))
  })
})
