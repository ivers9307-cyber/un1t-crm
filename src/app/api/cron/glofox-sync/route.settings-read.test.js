// REGISTRYREAD.1b — the daily member sync records a failed Glofox settings
// read with the true text ("couldn't read the settings") on the location's
// failed audit row, instead of "Glofox credentials missing on this
// location." Same row, same status, same heartbeat; the next run retries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ runUpdates: [] }))

const LOC = { id: 'loc-1', name: 'Studio', settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } } }

function result(st) {
  if (st.table === 'locations') return { data: [LOC], error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'insert') return { data: { id: 'run-1' }, error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'update') { h.runUpdates.push(st.payload); return { data: null, error: null } }
  throw new Error(`unexpected ${st.op} on ${st.table}`)
}
function builder(table) {
  const st = { table, op: 'select', payload: null }
  const b = {}
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'range', 'filter', 'single']) b[m] = () => b
  b.insert = (p) => { st.op = 'insert'; st.payload = p; return b }
  b.update = (p) => { st.op = 'update'; st.payload = p; return b }
  b.then = (resolve, reject) => Promise.resolve().then(() => result(st)).then(resolve, reject)
  return b
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: (t) => builder(t) }) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/tenant-heartbeat', () => ({ stampTenantHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/glofox-catalog', () => ({ syncMembershipCatalog: vi.fn(async () => { throw new Error('catalog must not be synced') }) }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn(async () => { throw new Error('no member sync expected') }) }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  fetchAllMembersPage: vi.fn(async () => { throw new Error('fetchAllMembersPage must not be called') }),
  glofoxHttpStats: vi.fn(() => ({})),
  glofoxHttpStatsSince: vi.fn(() => ({ requests: 9, retries: 1, status_429: 1, status_5xx: 0, network_errors: 0, gave_up: 0 })),
}))

import { GET } from './route.js'
import { glofoxCredentialsForLocation, fetchAllMembersPage } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { stampTenantHeartbeat } from '@/lib/tenant-heartbeat'
import { GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'

const req = (auth = 'Bearer test-secret') => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.runUpdates = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('GET /api/cron/glofox-sync — REGISTRYREAD.1b', () => {
  it('an unreadable settings row fails the location with the true text and calls no Glofox; the heartbeat still stamps', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const out = await (await GET(req())).json()
    expect(out.per_location[0]).toMatchObject({ status: 'failed', first_error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    expect(h.runUpdates.at(-1)).toMatchObject({ status: 'failed', first_error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    expect(fetchAllMembersPage).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-sync')
    expect(stampTenantHeartbeat).not.toHaveBeenCalled()
  })

  it('a location with no credentials keeps its old text', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: null })
    const out = await (await GET(req())).json()
    expect(out.per_location[0]).toMatchObject({ status: 'failed', first_error: 'Glofox credentials missing on this location.' })
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-sync')
  })

  it('CREDITSREAD.1 — counts syncs that could not read credits, and records Glofox traffic on the run row', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
    fetchAllMembersPage.mockResolvedValueOnce({ data: [{ _id: 'm1', modified: 0 }, { _id: 'm2', modified: 0 }], total: 2, hasMore: false })
    applyMemberSync
      .mockResolvedValueOnce({ action: 'update', credits_unread: true })
      .mockResolvedValueOnce({ action: 'update' })
    const out = await (await GET(req())).json()
    expect(out.per_location[0].summary).toMatchObject({ update: 2, credits_unread: 1 })
    expect(out.totals.summary.credits_unread).toBe(1)
    const done = h.runUpdates.find((u) => u.status === 'completed')
    expect(done.summary).toMatchObject({ update: 2, credits_unread: 1 })
    expect(done.summary.glofox_http).toEqual({ requests: 9, retries: 1, status_429: 1, status_5xx: 0, network_errors: 0, gave_up: 0 })
  })
})
