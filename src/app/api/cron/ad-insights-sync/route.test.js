// CRONREADERR.1 — ad-insights-sync. A failed ad_accounts read is not "no
// accounts": it answers 500 and does NOT stamp (the next 4-hourly run re-pulls
// yesterday + today, so nothing is lost; mig 644's 14400 + 18000 absorbs one
// missed run). A Meta failure on one account still stamps (the row watches
// the cron, not Meta), and the two per-account bookkeeping writes are no
// longer discarded.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let accountsResult = { data: [], error: null }
let updateResults = []
const updates = []

function builder(table) {
  const b = { op: 'select', patch: null, filters: [] }
  b.select = () => b
  b.eq = (col, val) => { b.filters.push([col, val]); return b }
  b.update = (patch) => { b.op = 'update'; b.patch = patch; return b }
  b.then = (resolve, reject) => {
    let out = { data: null, error: null }
    if (table === 'ad_accounts' && b.op === 'select') out = accountsResult
    if (table === 'ad_accounts' && b.op === 'update') {
      updates.push({ patch: b.patch, filters: b.filters })
      out = updateResults.shift() || { data: null, error: null }
    }
    return Promise.resolve(out).then(resolve, reject)
  }
  return b
}
const fakeDb = { from: (t) => builder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/ads/sync', () => ({ syncAccount: vi.fn(async () => ({})) }))
vi.mock('@/lib/ads/providers/meta', () => ({ name: 'meta' }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'
import { syncAccount } from '@/lib/ads/sync'

const req = (auth = 'Bearer test-secret') => ({
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) },
})
const ACC = { id: 'acc-1', provider: 'meta', is_active: true }
const READ_ERR = { message: 'canceling statement due to statement timeout', code: '57014' }

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  accountsResult = { data: [ACC], error: null }
  updateResults = []
  updates.length = 0
  syncAccount.mockResolvedValue({})
})

describe('GET /api/cron/ad-insights-sync — read errors (CRONREADERR.1)', () => {
  it('a failed ad_accounts read is a fault: 500, logged, nothing synced, heartbeat NOT stamped', async () => {
    accountsResult = { data: null, error: READ_ERR }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(syncAccount).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'cron-ad-insights-sync',
      'ad_accounts read failed; nothing synced, heartbeat not stamped',
      expect.objectContaining({ err: expect.objectContaining({ code: '57014' }) }),
    )
  })

  it('no active accounts is a healthy quiet run: 200 and stamped (unchanged)', async () => {
    accountsResult = { data: [], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledWith('ad-insights-sync')
  })

  it('one account failing at Meta still stamps: the row watches the cron, not Meta (unchanged)', async () => {
    syncAccount.mockRejectedValue(new Error('Meta 500'))
    const body = await (await GET(req())).json()
    expect(body.results).toEqual([{ id: 'acc-1', error: 'Meta 500' }])
    expect(updates[0].patch).toEqual({ last_sync_error: 'Meta 500' })
    expect(stampHeartbeat).toHaveBeenCalledWith('ad-insights-sync')
  })

  it('a failed last_sync_error write is logged WITH the sync error it was meant to record', async () => {
    syncAccount.mockRejectedValue(new Error('Meta 500'))
    updateResults = [{ data: null, error: { message: 'write failed' } }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledWith(
      'cron-ad-insights-sync',
      'could not record the account sync error',
      expect.objectContaining({ accountId: 'acc-1', syncError: 'Meta 500', err: expect.objectContaining({ message: 'write failed' }) }),
    )
    expect(stampHeartbeat).toHaveBeenCalledWith('ad-insights-sync')
  })

  it('a failed last_synced_at write after a good sync is a warning; the account is still ok and the tick stamps', async () => {
    updateResults = [{ data: null, error: { message: 'write failed' } }]
    const body = await (await GET(req())).json()
    expect(body.results).toEqual([{ id: 'acc-1', ok: true }])
    expect(logWarn).toHaveBeenCalledWith(
      'cron-ad-insights-sync',
      'could not record the account sync time',
      expect.objectContaining({ accountId: 'acc-1', err: expect.objectContaining({ message: 'write failed' }) }),
    )
    expect(stampHeartbeat).toHaveBeenCalledWith('ad-insights-sync')
  })
})
