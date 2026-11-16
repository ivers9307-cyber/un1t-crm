// ORGCONTACTS.1 (plan Task 10) + RECONCILEBATCH.1 — the nightly contact_studios
// reconcile cron:
//   1. 401 without CRON_SECRET;
//   2. batches of reconcile_contact_studios_batch (mig 846) from the first
//      contact until `done`; summed counts are the heartbeat outcome and the
//      response;
//   3. a failed batch, or running out of time, is a 500 with NO heartbeat;
//   4. ORGCONTACTS.8: the run time (duration_ms) rides on the heartbeat and the
//      response, and a run past SLOW_RUN_MS warns.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ rpc: null, noPrimary: { count: 3, error: null } }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    rpc: (...args) => h.rpc(...args),
    from: () => ({ select: () => ({ is: async () => h.noPrimary }) }),
  }),
}))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { GET, CRON_NAME, SLOW_RUN_MS, BATCH_CONTACTS, RUN_DEADLINE_MS } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'

const req = (token = 'test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
})
const batch = (n, extra = {}) => ({ inserted: n, updated: 2 * n, ended: 0, unchanged: 100, last_contact_id: `c-${n}`, done: false, ...extra })

// Three batches; each advances the faked Date.now() by ms.
function batchesTaking(ms, rows = [batch(1), batch(2), batch(3, { done: true })]) {
  let t = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => t)
  let i = 0
  h.rpc = vi.fn(async () => { t += ms; return { data: [rows[Math.min(i++, rows.length - 1)]], error: null } })
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.restoreAllMocks()
  vi.clearAllMocks()
  h.noPrimary = { count: 3, error: null }
  batchesTaking(100)
})

describe('GET /api/cron/contact-studios-reconcile', () => {
  it('is 401 without the secret and calls nothing', async () => {
    const res = await GET(req(null))
    expect(res.status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('reconciles in batches from the first contact until done, and stamps the summed counts', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(CRON_NAME).toBe('contact-studios-reconcile')
    expect(h.rpc.mock.calls.map((c) => c[1])).toEqual([
      { p_after: null, p_limit: BATCH_CONTACTS },
      { p_after: 'c-1', p_limit: BATCH_CONTACTS },
      { p_after: 'c-2', p_limit: BATCH_CONTACTS },
    ])
    expect(h.rpc.mock.calls.every((c) => c[0] === 'reconcile_contact_studios_batch')).toBe(true)
    const expected = { inserted: 6, updated: 12, ended: 0, unchanged: 300, skipped_no_primary: 3, batches: 3, duration_ms: 300 }
    expect(stampHeartbeat).toHaveBeenCalledWith('contact-studios-reconcile', expected)
    expect(await res.json()).toEqual({ success: true, ...expected })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a batch that does not advance stops the loop rather than spinning', async () => {
    batchesTaking(10, [batch(1, { last_contact_id: null })])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })

  it('a failed batch is a 500 with no heartbeat', async () => {
    h.rpc = vi.fn(async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('contact-studios-reconcile', expect.stringMatching(/failed; no heartbeat/), expect.objectContaining({ code: '57014' }))
  })

  it('running out of time before the last batch is a 500 with no heartbeat', async () => {
    batchesTaking(RUN_DEADLINE_MS + 1, [batch(1), batch(2)])
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a run past half its time limit still stamps, and warns', async () => {
    expect(SLOW_RUN_MS).toBe(150_000)
    batchesTaking(SLOW_RUN_MS / 2 + 1)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('contact-studios-reconcile', expect.stringMatching(/half its time limit/), expect.anything())
  })

  it('an unreadable no-studio count is a warning, not a failure', async () => {
    h.noPrimary = { count: null, error: { message: 'down' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).skipped_no_primary).toBe(0)
  })
})
