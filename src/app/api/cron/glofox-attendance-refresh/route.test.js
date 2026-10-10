// MEMBERRESULT.1 — the attendance refresh must never write a member's
// membership/profile columns from a Glofox refusal. Live 30 Aug 2026: a
// "Resource not available" 200 was read as a member and 16 columns went NULL.
//
// The REAL fetchMemberResult (glofox.js) and the REAL extract* functions
// (glofox-sync.js) run here, against a stubbed fetch, so this proves the
// wiring end to end, not that a mock was called.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// W1.M3b — discovery now goes through the membership seam, which reads the
// credentials ONCE at discovery (membershipSourceState) before the per-location
// re-read these tests exercise: the first answer is the seam's, the second the
// run's.

const h = vi.hoisted(() => ({ members: [], contactUpdates: [], runUpdates: [] }))

const LOC = { id: 'loc-1', name: 'Studio', active: true, membership_source: 'glofox', settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } } }
const GOOD = '0000000000000000000000a1'
const REFUSED = '0000000000000000000000b2'
const GONE = '0000000000000000000000c3'
const CODE = 'Resource not available, empty result cant be processed'

function result(st) {
  if (st.table === 'locations') return { data: st.single ? LOC : [LOC], error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'insert') return { data: { id: 'run-1' }, error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'update') { h.runUpdates.push(st.payload); return { data: null, error: null } }
  if (st.table === 'contacts' && st.op === 'update') { h.contactUpdates.push({ id: st.eqId, patch: st.payload }); return { data: null, error: null } }
  if (st.table === 'contacts') return { data: h.members, error: null }
  throw new Error(`unexpected ${st.op} on ${st.table}`)
}
function builder(table) {
  const st = { table, op: 'select', payload: null, eqId: null }
  const b = {}
  for (const m of ['select', 'in', 'not', 'order', 'range', 'filter', 'single']) b[m] = () => b
  b.eq = (col, val) => { if (col === 'id') st.eqId = val; return b }
  b.maybeSingle = () => { st.single = true; return b }
  b.insert = (p) => { st.op = 'insert'; st.payload = p; return b }
  b.update = (p) => { st.op = 'update'; st.payload = p; return b }
  b.then = (resolve, reject) => Promise.resolve().then(() => result(st)).then(resolve, reject)
  return b
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: (t) => builder(t) }) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
}))

import { GET } from './route.js'
import { logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { extractMemberProfile } from '@/lib/glofox-sync'

// Every column a member read writes: the ones a refusal must never touch.
const MEMBER_READ_KEYS = ['glofox_membership_plan', 'glofox_membership_state', ...Object.keys(extractMemberProfile({}))]

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })
function glofoxAnswer(url) {
  const id = String(url).split('?')[0].split('/').pop()
  if (id === GOOD) {
    return res(200, { data: {
      _id: GOOD, active: true, source: 'MEMBER_APP',
      membership: { membership_plan_name: 'Monthly Membership', status: 'ACTIVE', type: 'time', user_membership_id: 'um-good' },
    } })
  }
  if (id === REFUSED) return res(200, { success: false, message: CODE, message_code: CODE })
  if (id === GONE) return res(404, { message: 'not found' })
  throw new Error(`unexpected Glofox call ${url}`)
}
const member = (id, gid) => ({ id, glofox_member_id: gid, last_attended_at: null, last_booked_at: null })
const req = (auth = 'Bearer test-secret') => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })
const patchFor = (id) => h.contactUpdates.find((u) => u.id === id)?.patch

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  vi.clearAllMocks()
  h.members = [member('c-good', GOOD), member('c-refused', REFUSED), member('c-gone', GONE)]
  h.contactUpdates = []
  h.runUpdates = []
  vi.stubGlobal('fetch', vi.fn(async (url) => glofoxAnswer(url)))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('GET /api/cron/glofox-attendance-refresh — MEMBERRESULT.1', () => {
  it('a refused member keeps every stored membership field and still saves attendance', async () => {
    const out = await (await GET(req())).json()
    expect(out.success).toBe(true)

    const refused = patchFor('c-refused')
    expect(refused).toBeDefined()                          // the row is still written…
    expect(refused.glofox_synced_at).toEqual(expect.any(String))
    expect(refused).toHaveProperty('total_bookings_30d')   // …with its attendance
    for (const k of MEMBER_READ_KEYS) expect(refused).not.toHaveProperty(k)
  })

  it('counts the refusal apart from a transient failure, and logs it structurally', async () => {
    const out = await (await GET(req())).json()
    const expected = { refreshed: 3, fetch_failed: 0, update_failed: 0, membership_failed: 1, member_refused: 1 }
    expect(out.per_location[0].summary).toEqual(expected)
    expect(h.runUpdates.at(-1).summary).toEqual({ ...expected, glofox_http: expect.any(Object) })
    expect(logWarn).toHaveBeenCalledWith(
      'glofox-attendance-refresh',
      expect.stringContaining('refused'),
      { locationId: 'loc-1', contactId: 'c-refused', messageCode: CODE },
    )
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-attendance-refresh', expect.any(Object))
  })

  it('a real member still gets every field (unchanged)', async () => {
    await GET(req())
    const good = patchFor('c-good')
    for (const k of MEMBER_READ_KEYS) expect(good).toHaveProperty(k)
    expect(good).toMatchObject({
      glofox_membership_plan: 'Monthly Membership',
      glofox_membership_state: 'active',
      glofox_membership_type: 'time',
      glofox_account_active: true,
      glofox_user_membership_id: 'um-good',
    })
  })

  it('a transient member-read failure keeps the fields too (unchanged)', async () => {
    await GET(req())
    const gone = patchFor('c-gone')
    for (const k of MEMBER_READ_KEYS) expect(gone).not.toHaveProperty(k)
  })

  it('CREDITSREAD.1 — the heartbeat records reach and Glofox traffic; the run row carries the traffic', async () => {
    await GET(req())
    // fetchUserBookingsResult is mocked; the three member GETs are real glofoxFetch calls.
    const [, outcome] = stampHeartbeat.mock.calls.at(-1)
    expect(outcome).toMatchObject({
      eligible: 3, refreshed: 3, fetch_failed: 0, membership_failed: 1, member_refused: 1, update_failed: 0,
      budget_exhausted: false,
    })
    expect(outcome.glofox_http.requests).toBeGreaterThanOrEqual(3)
    expect(outcome.glofox_http.gave_up).toBe(0)
    expect(h.runUpdates.at(-1).summary.glofox_http.requests).toBeGreaterThanOrEqual(3)
  })
})

describe('GET /api/cron/glofox-attendance-refresh — REGISTRYREAD.1b unreadable settings', () => {
  it('records the true text on the failed location row, calls no Glofox, and still stamps the heartbeat', async () => {
    const { glofoxCredentialsForLocation } = await import('@/lib/glofox')
    const { GLOFOX_SETTINGS_UNREADABLE_MESSAGE } = await import('@/lib/glofox-settings-read')

    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }) // the seam's discovery read
      .mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const out = await (await GET(req())).json()
    expect(out.per_location[0]).toMatchObject({ status: 'failed', error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    expect(h.runUpdates.at(-1)).toMatchObject({ status: 'failed', first_error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE })
    expect(fetch).not.toHaveBeenCalled()
    expect(h.contactUpdates).toEqual([])
    expect(stampHeartbeat).toHaveBeenCalledWith('glofox-attendance-refresh', expect.any(Object))
  })

  it('CREDITSREAD.1 — a run where every location failed says so in last_outcome (not all zeros)', async () => {
    const { glofoxCredentialsForLocation } = await import('@/lib/glofox')
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }) // the seam's discovery read
      .mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    const [name, outcome] = stampHeartbeat.mock.calls[0]
    expect(name).toBe('glofox-attendance-refresh')
    expect(outcome.failed_locations).toBe(1)
    expect(outcome.refreshed).toBe(0)
  })

  it('CREDITSREAD.1 — a healthy run records failed_locations: 0', async () => {
    await GET(req())
    expect(stampHeartbeat.mock.calls.at(-1)[1].failed_locations).toBe(0)
  })

  it('a location with no credentials keeps its old text', async () => {
    const { glofoxCredentialsForLocation } = await import('@/lib/glofox')
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null }) // the seam's discovery read
      .mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: null })
    const out = await (await GET(req())).json()
    expect(out.per_location[0]).toMatchObject({ status: 'failed', error: 'Glofox credentials missing on this location.' })
  })
})
