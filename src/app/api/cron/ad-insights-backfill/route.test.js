// ROUTEWRAP.C5 — ad-insights-backfill on defineCron. A manual job with no
// heartbeat row: no path stamps anything. An unreadable ad_accounts list is a
// failed run (it used to answer success with no results).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/ads/sync', () => ({ syncAccount: vi.fn(async () => ({})) }))
vi.mock('@/lib/ads/providers/meta', () => ({ name: 'meta' }))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { syncAccount } = await import('@/lib/ads/sync')
const { logError, logWarn } = await import('@/lib/log')

const LOC = { id: 'loc-1', timezone: 'Europe/Dublin' }
const ACC = { id: 'acc-1', location_id: 'loc-1', provider: 'meta', external_account_id: 'act_1', is_active: true }
const req = (secret = 'shh', qs = '?since=2026-10-01&until=2026-10-31') =>
  new Request(`https://x.test/api/cron/ad-insights-backfill${qs}`, { headers: { authorization: `Bearer ${secret}` } })
const seed = (extra = {}) => createFakeDb({ tables: { locations: [LOC], ad_accounts: [ACC] }, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  db = seed()
  syncAccount.mockResolvedValue({})
})

describe('GET /api/cron/ad-insights-backfill', () => {
  it('401s without the secret, reading nothing and stamping nothing', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(db.calls).toEqual([])
    expect(syncAccount).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run backfills each account over the given window and stamps nothing', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, results: [{ id: 'acc-1', ok: true, since: '2026-10-01', until: '2026-10-31' }] })
    expect(syncAccount).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'acc-1' }), expect.anything(), expect.objectContaining({ since: '2026-10-01', until: '2026-10-31' }))
    expect(db.tables.ad_accounts[0].last_sync_error).toBeNull()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('one account failing is a result with a fixed line; the detail is logged and recorded on the row', async () => {
    syncAccount.mockRejectedValue(new Error('Meta says secret_m'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([{ id: 'acc-1', error: 'backfill failed' }])
    expect(JSON.stringify(body)).not.toContain('secret_m')
    expect(db.tables.ad_accounts[0].last_sync_error).toBe('Meta says secret_m')
    expect(logWarn).toHaveBeenCalledWith('cron-ad-insights-backfill', 'account backfill failed', expect.objectContaining({ accountId: 'acc-1' }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed ad_accounts read is a failed run: 500, a fixed line, nothing synced or stamped', async () => {
    db = seed({ errors: { ad_accounts: { select: { message: 'relation secret_a does not exist' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read ad accounts' })
    expect(JSON.stringify(body)).not.toContain('secret_a')
    expect(syncAccount).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron-ad-insights-backfill', expect.stringMatching(/read failed/), expect.anything())
  })
})
