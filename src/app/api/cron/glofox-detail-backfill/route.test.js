// MEMBERRESULT.1 — the detail backfill must not hand a Glofox refusal to the
// sync as if it were a member. It used to: applyMemberSync found no _id and
// answered 'invalid', so ~142 refusals a day hid in `invalid` (one refused id,
// re-read every 10 minutes since 30 Aug 2026).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ candidates: [], runUpdates: [] }))

const LOC = { id: 'loc-1', name: 'Studio', settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } } }
const GOOD = '0000000000000000000000a1'
const REFUSED = '0000000000000000000000b2'
const GONE = '0000000000000000000000c3'
const CODE = 'Resource not available, empty result cant be processed'

function result(st) {
  if (st.table === 'locations') return { data: [LOC], error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'insert') return { data: { id: 'run-1' }, error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'update') { h.runUpdates.push(st.payload); return { data: null, error: null } }
  if (st.table === 'contacts' && st.head) return { data: null, count: 0, error: null }
  if (st.table === 'contacts') return { data: h.candidates, error: null }
  throw new Error(`unexpected ${st.op} on ${st.table}`)
}
function builder(table) {
  const st = { table, op: 'select', payload: null, head: false }
  const b = {}
  for (const m of ['eq', 'in', 'not', 'or', 'is', 'order', 'range', 'filter', 'single']) b[m] = () => b
  b.select = (_cols, opts) => { if (opts?.head) st.head = true; return b }
  b.insert = (p) => { st.op = 'insert'; st.payload = p; return b }
  b.update = (p) => { st.op = 'update'; st.payload = p; return b }
  b.then = (resolve, reject) => Promise.resolve().then(() => result(st)).then(resolve, reject)
  return b
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: (t) => builder(t) }) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn(async () => ({ action: 'update' })) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
}))

import { GET } from './route.js'
import { applyMemberSync } from '@/lib/glofox-sync'
import { logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })
function glofoxAnswer(url) {
  const id = String(url).split('?')[0].split('/').pop()
  if (id === GOOD) return res(200, { data: { _id: GOOD, active: true, membership: { status: 'ACTIVE' } } })
  if (id === REFUSED) return res(200, { success: false, message: CODE, message_code: CODE })
  if (id === GONE) return res(404, { message: 'not found' })
  throw new Error(`unexpected Glofox call ${url}`)
}
const cand = (id, gid) => ({ id, glofox_member_id: gid, glofox_membership_plan: null, glofox_synced_at: null })
const req = (auth = 'Bearer test-secret') => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.candidates = [cand('c-good', GOOD), cand('c-refused', REFUSED), cand('c-gone', GONE)]
  h.runUpdates = []
  vi.stubGlobal('fetch', vi.fn(async (url) => glofoxAnswer(url)))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('GET /api/cron/glofox-detail-backfill — MEMBERRESULT.1', () => {
  it('never hands a refusal to the sync; only the real member is applied', async () => {
    await GET(req())
    expect(applyMemberSync).toHaveBeenCalledTimes(1)
    expect(applyMemberSync.mock.calls[0][2]).toMatchObject({ _id: GOOD })
  })

  it('counts the refusal as member_refused, not invalid and not fetch_failed, and logs the count once', async () => {
    const out = await (await GET(req())).json()
    const expected = { create: 0, update: 1, leave: 0, fetch_failed: 1, error: 0, ambiguous: 0, invalid: 0, member_refused: 1 }
    expect(out.per_location[0].summary).toEqual(expected)
    expect(h.runUpdates.at(-1).summary).toEqual({ ...expected, remaining_missing_plan: 0 })
    expect(logWarn).toHaveBeenCalledWith(
      'glofox-detail-backfill',
      expect.stringContaining('refused'),
      { locationId: 'loc-1', refused: 1 },
    )
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-detail-backfill')
  })

  it('a run with no refusals logs nothing', async () => {
    h.candidates = [cand('c-good', GOOD)]
    await GET(req())
    expect(logWarn).not.toHaveBeenCalled()
  })
})
