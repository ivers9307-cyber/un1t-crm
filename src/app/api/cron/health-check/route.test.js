// STALEWATCH.1 — an acknowledged stale job no longer holds the health check red;
// it is listed under `acknowledged`. A stale, unacknowledged job still 503s.
// ROUTEWRAP.C8 — on defineCron: the secret, no stamp on any answer, and a fixed
// error when cron_health cannot be read twice.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => h.db) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { GET } = await import('./route.js')
const { createServerClient } = await import('@/lib/supabase')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logWarn } = await import('@/lib/log')
const call = (auth = 'Bearer s3cret') => GET(new Request('http://x', { headers: auth ? { authorization: auth } : {} }))
const withChecks = (checks, opts = {}) => { h.db = createFakeDb({ tables: { cron_health: checks, tenant_cron_health: opts.tenant || [] }, errors: opts.errors }) }
const reads = () => h.db.calls.filter((c) => c.table === 'cron_health').length

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 's3cret'
  withChecks([])
})

describe('GET /api/cron/health-check', () => {
  it('401 without the secret: nothing read, nothing stamped', async () => {
    for (const auth of [null, 'Bearer wrong']) expect((await call(auth)).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await call('Bearer undefined')).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('every job fresh is a 200 and stamps nothing (a status reader, not a worker)', async () => {
    withChecks([{ name: 'a', is_stale: false, is_acknowledged: false }], { tenant: [{ name: 't', location_id: 'loc-1', is_stale: true, stale_seconds: 9 }] })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, all_healthy: true, stale: [], acknowledged: [], tenant_stale: [{ name: 't', location_id: 'loc-1', stale_seconds: 9 }] })
    expect(body.checks.map((c) => c.name)).toEqual(['a'])
    expect(typeof body.checked_at).toBe('string')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a stale, unacknowledged job is a 503', async () => {
    withChecks([{ name: 'a', is_stale: true, is_acknowledged: false }, { name: 'b', is_stale: false }])
    const res = await call()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ success: false, all_healthy: false, stale: ['a'] })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an acknowledged stale job is listed but does not hold it red', async () => {
    withChecks([{ name: 'a', is_stale: true, is_acknowledged: true, acknowledged_until: '2026-11-20T00:00:00Z', acknowledged_note: 'token' }])
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stale).toEqual([])
    expect(body.acknowledged).toEqual([{ name: 'a', until: '2026-11-20T00:00:00Z', note: 'token' }])
  })

  it('a second job going stale turns it red even with the first acknowledged', async () => {
    withChecks([{ name: 'a', is_stale: true, is_acknowledged: true }, { name: 'b', is_stale: true, is_acknowledged: false }])
    expect((await call()).status).toBe(503)
  })

  it('cron_health unreadable twice is a 503 with a fixed error (no DB text) and no stamp', async () => {
    withChecks([], { errors: { cron_health: { select: { code: 'XX000', message: 'pooler db.internal refused' } } } })
    const res = await call()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read cron health', all_healthy: false })
    expect(reads()).toBe(2)
    expect(logWarn).toHaveBeenCalledWith('cron-health-check', 'cron_health read failed', expect.objectContaining({ err: expect.objectContaining({ code: 'XX000' }) }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
