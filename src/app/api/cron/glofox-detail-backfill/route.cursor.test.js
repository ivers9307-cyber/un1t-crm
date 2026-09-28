// DETAILBACKFILL.1 — the detail backfill's selection. Live until this PR: the
// candidate query ordered "plan IS NULL" first and PostgREST capped it at
// 1,000 rows, so 2,926 contacts with no plan were re-read every ~30 minutes
// (~288k Glofox calls a day) and 2,917 with a plan waited since 3 Jul.
//
// The REAL fetchMemberResult (glofox.js, C11's contract) runs here against a
// stubbed fetch; applyMemberSync is mocked (what it writes is unchanged).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  candidates: [], candErr: null, stampErr: null, countResult: { count: 0, error: null },
  candidateChains: [], countChains: [], contactUpdates: [], runInserts: [], runUpdates: [],
}))

const LOC = { id: 'loc-1', name: 'Studio', settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } } }
const NOW = Date.parse('2026-10-01T09:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const HOUR = 3_600_000
const DAY = 24 * HOUR
const CODE = 'Resource not available, empty result cant be processed'
const STATUSES = ['member', 'credit_member', 'trial', 'classpass_payg', 'no_sale_trial']

function result(st) {
  if (st.table === 'locations') return { data: [LOC], error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'insert') { h.runInserts.push(st.payload); return { data: { id: 'run-1' }, error: null } }
  if (st.table === 'glofox_sync_runs' && st.op === 'update') { h.runUpdates.push(st.payload); return { data: null, error: null } }
  if (st.table === 'contacts' && st.op === 'update') {
    h.contactUpdates.push({ id: st.eqId, patch: st.payload })
    return { data: null, error: h.stampErr }
  }
  if (st.table === 'contacts' && st.head) { h.countChains.push(st.chain); return h.countResult }
  if (st.table === 'contacts') {
    h.candidateChains.push(st.chain)
    if (h.candErr) return { data: null, error: h.candErr }
    // PostgREST: never more than 1,000 rows, whatever .range() asks for.
    const [from, to] = st.range ?? [0, 999]
    return { data: h.candidates.slice(from, Math.min(to, from + 999) + 1), error: null }
  }
  throw new Error(`unexpected ${st.op} on ${st.table}`)
}
function builder(table) {
  const st = { table, op: 'select', payload: null, head: false, eqId: null, range: null, chain: [] }
  const b = {}
  const record = (name) => (...args) => { st.chain.push([name, ...args]); return b }
  for (const m of ['in', 'not', 'or', 'is', 'lt', 'lte', 'order', 'filter', 'single', 'limit']) b[m] = record(m)
  b.eq = (col, val) => { st.chain.push(['eq', col, val]); if (col === 'id') st.eqId = val; return b }
  b.range = (from, to) => { st.chain.push(['range', from, to]); st.range = [from, to]; return b }
  b.select = (cols, opts) => { st.chain.push(['select', cols]); if (opts?.head) st.head = true; return b }
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
import { logWarn, logError } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })
function glofoxAnswer(url) {
  const id = String(url).split('?')[0].split('/').pop()
  if (id.startsWith('refused')) return res(200, { success: false, message: CODE, message_code: CODE })
  if (id.startsWith('gone')) return res(404, { message: 'not found' })
  return res(200, { data: { _id: id, active: true, membership: { status: 'ACTIVE' } } })
}
const memberReads = () => global.fetch.mock.calls
  .map(([u]) => String(u)).filter((u) => u.includes('/2.0/members/'))
  .map((u) => u.split('?')[0].split('/').pop())
const cand = (gid) => ({ id: `c-${gid}`, glofox_member_id: gid, glofox_detail_due_at: null, glofox_synced_at: null })
const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const ors = (chain) => chain.filter(([m]) => m === 'or').map(([, s]) => s)

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.clearAllMocks()
  Object.assign(h, {
    candidates: [cand('good1'), cand('refused1'), cand('gone1')],
    candErr: null, stampErr: null, countResult: { count: 0, error: null },
    candidateChains: [], countChains: [], contactUpdates: [], runInserts: [], runUpdates: [],
  })
  vi.stubGlobal('fetch', vi.fn(async (url) => glofoxAnswer(url)))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('GET /api/cron/glofox-detail-backfill — DETAILBACKFILL.1 cursor', () => {
  it('picks by the due cursor, never by "plan is null", oldest first, one bounded page', async () => {
    await GET(req())
    expect(h.candidateChains).toHaveLength(1)
    const chain = h.candidateChains[0]
    expect(ors(chain)).toEqual([`glofox_detail_due_at.is.null,glofox_detail_due_at.lte.${NOW_ISO}`])
    expect(JSON.stringify(chain)).not.toContain('glofox_membership_plan')
    expect(chain).toContainEqual(['select', 'id, glofox_member_id, glofox_detail_due_at, glofox_synced_at'])
    expect(chain).toContainEqual(['eq', 'location_id', 'loc-1'])
    expect(chain).toContainEqual(['in', 'glofox_membership_status', STATUSES])
    expect(chain).toContainEqual(['not', 'glofox_member_id', 'is', null])
    expect(chain.filter(([m]) => m === 'order')).toEqual([
      ['order', 'glofox_detail_due_at', { ascending: true, nullsFirst: true }],
      ['order', 'glofox_synced_at', { ascending: true, nullsFirst: true }],
      ['order', 'id', { ascending: true }],
    ])
    expect(chain.filter(([m]) => m === 'range')).toEqual([['range', 0, 99]])
  })

  it('reads at most 100 members a tick, each once, however many are due', async () => {
    h.candidates = Array.from({ length: 250 }, (_, i) => cand(`g${String(i).padStart(3, '0')}`))
    const out = await (await GET(req())).json()
    const reads = memberReads()
    expect(reads).toHaveLength(100)
    expect(new Set(reads)).toEqual(new Set(h.candidates.slice(0, 100).map((c) => c.glofox_member_id)))
    expect(out.per_location[0].candidates_seen).toBe(100)
  })

  it('stamps every contact it tried, whatever Glofox answered', async () => {
    await GET(req())
    const due = Object.fromEntries(h.contactUpdates.map((u) => [u.id, Date.parse(u.patch.glofox_detail_due_at)]))
    expect(Object.keys(due).sort()).toEqual(['c-gone1', 'c-good1', 'c-refused1'])
    for (const u of h.contactUpdates) expect(Object.keys(u.patch)).toEqual(['glofox_detail_due_at'])
    // answered — a real member, or Glofox refusing it: back in 10.5–17.5 days
    for (const id of ['c-good1', 'c-refused1']) {
      expect(due[id]).toBeGreaterThanOrEqual(NOW + 10.5 * DAY)
      expect(due[id]).toBeLessThan(NOW + 17.5 * DAY)
    }
    // failed (404): retried in 6 hours — not next tick, not in two weeks
    expect(due['c-gone1']).toBe(NOW + 6 * HOUR)
  })

  it('a sync error is retried in 6 hours too', async () => {
    applyMemberSync.mockResolvedValueOnce({ action: 'update', error: 'write failed' })
    h.candidates = [cand('good1')]
    const out = await (await GET(req())).json()
    expect(out.per_location[0].summary.error).toBe(1)
    expect(Date.parse(h.contactUpdates[0].patch.glofox_detail_due_at)).toBe(NOW + 6 * HOUR)
  })

  it('counts the outcomes, records the new progress signal, and tells the heartbeat', async () => {
    h.countResult = { count: 42, error: null }
    const out = await (await GET(req())).json()
    const expected = { create: 0, update: 1, leave: 0, fetch_failed: 1, error: 0, ambiguous: 0, invalid: 0, member_refused: 1, stamp_failed: 0 }
    expect(out.success).toBe(true)
    expect(out.per_location[0].summary).toEqual(expected)
    expect(out.per_location[0].remaining_due).toBe(42)
    expect(h.runUpdates.at(-1).summary).toEqual({ ...expected, remaining_due: 42 })
    expect(h.runInserts[0].filter_used).toEqual({
      detail_backfill: true, statuses: STATUSES, sweep_days: 14, retry_hours: 6, per_tick: 100,
    })
    // "remaining" counts what is still due, by the same cursor predicate
    expect(ors(h.countChains[0])).toEqual([`glofox_detail_due_at.is.null,glofox_detail_due_at.lte.${NOW_ISO}`])
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-detail-backfill', {
      candidates_seen: 3, remaining_due: 42, member_refused: 1, fetch_failed: 1, error: 0, stamp_failed: 0,
    })
  })

  it('nothing due: no Glofox call, a healthy quiet run', async () => {
    h.candidates = []
    const out = await (await GET(req())).json()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(out.per_location[0].status).toBe('completed')
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-detail-backfill', expect.objectContaining({ candidates_seen: 0 }))
  })

  it('a failed remaining-due count is null and logged, never a failed run', async () => {
    h.countResult = { count: null, error: { message: 'boom' } }
    const out = await (await GET(req())).json()
    expect(out.per_location[0].status).toBe('completed')
    expect(out.per_location[0].remaining_due).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('glofox-detail-backfill', expect.stringContaining('count'), { locationId: 'loc-1', err: 'boom' })
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-detail-backfill', expect.objectContaining({ remaining_due: null }))
  })

  it('a failed stamp is counted and logged once; the run completes and still stamps its heartbeat', async () => {
    h.stampErr = { message: 'db down' }
    const out = await (await GET(req())).json()
    expect(out.per_location[0].status).toBe('completed')
    expect(out.per_location[0].summary.stamp_failed).toBe(3)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('glofox-detail-backfill', expect.stringContaining('re-read next tick'), { locationId: 'loc-1', stampFailed: 3 })
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('a failed candidate read is a fault: nothing read, logged, heartbeat NOT stamped', async () => {
    h.candErr = { message: 'column contacts.glofox_detail_due_at does not exist' }
    const out = await (await GET(req())).json()
    expect(out.success).toBe(false)
    expect(out.per_location[0].status).toBe('failed')
    expect(memberReads()).toHaveLength(0)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('glofox-detail-backfill', expect.stringContaining('heartbeat not stamped'), {
      failed: [{ locationId: 'loc-1', error: 'column contacts.glofox_detail_due_at does not exist' }],
    })
    expect(h.runUpdates.at(-1)).toMatchObject({ status: 'failed', first_error: 'column contacts.glofox_detail_due_at does not exist' })
  })
})
