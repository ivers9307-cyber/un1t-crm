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

const h = vi.hoisted(() => ({ members: [], prospects: [], prospectQueries: [], contactUpdates: [], runUpdates: [], crossover: [], memberScopes: [] }))

const LOC = { id: 'loc-1', name: 'Studio', active: true, membership_source: 'glofox', settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } } }
const GOOD = '0000000000000000000000a1'
const REFUSED = '0000000000000000000000b2'
const GONE = '0000000000000000000000c3'
const CODE = 'Resource not available, empty result cant be processed'

function result(st) {
  if (st.table === 'locations') return { data: st.single ? LOC : [LOC], error: null }
  // ORGCONTACTS.2 — the studio's Glofox relationships (contact_studios; none unless a test sets them).
  if (st.table === 'contact_studios') return { data: (h.crossover || []).map((r) => ({ source: 'glofox', ...r })), error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'insert') return { data: { id: 'run-1' }, error: null }
  if (st.table === 'glofox_sync_runs' && st.op === 'update') { h.runUpdates.push(st.payload); return { data: null, error: null } }
  if (st.table === 'contacts' && st.op === 'update') { h.contactUpdates.push({ id: st.eqId, patch: st.payload }); return { data: null, error: null } }
  // ATTPROSPECTS.1 — two contact lists: the paying members (.in on status)
  // and the active non-members (.not … in + .or).
  if (st.table === 'contacts' && st.memberList) { h.memberScopes.push(st.scope ?? null); return { data: h.members, error: null } }
  if (st.table === 'contacts' && st.prospectList) { h.prospectQueries.push({ notIn: st.notIn, or: st.or }); return { data: h.prospects, error: null } }
  throw new Error(`unexpected ${st.op} on ${st.table}`)
}
function builder(table) {
  const st = { table, op: 'select', payload: null, eqId: null }
  const b = {}
  for (const m of ['select', 'order', 'range', 'filter', 'single']) b[m] = () => b
  b.in = (col) => { if (col === 'glofox_membership_status') st.memberList = true; return b }
  b.not = (col, op, val) => { if (col === 'glofox_membership_status' && op === 'in') { st.prospectList = true; st.notIn = val } return b }
  b.or = (val) => {
    // GLOFOXREADERS.1 — the studio/crossover scope is its own or(); keep it apart.
    if (String(val).startsWith('location_id.eq.')) st.scope = val
    else st.or = val
    return b
  }
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
  h.prospects = []
  h.prospectQueries = []
  h.contactUpdates = []
  h.runUpdates = []
  h.crossover = []
  h.memberScopes = []
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
    expect(h.runUpdates.at(-1).summary).toEqual({
      ...expected,
      prospects: { eligible: 0, refreshed: 0, fetch_failed: 0, update_failed: 0 },
      glofox_http: expect.any(Object),
    })
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

// ATTPROSPECTS.1 — trials, leads, tours and cold contacts who are active
// (a booking or class in the last 35 days, or a count still to decay) get the
// same bookings refresh, so their 7-/30-day counts are current. ClassPass is
// out (Richard, 15 Oct 2026). Bookings only: no member read for them.
describe('GET /api/cron/glofox-attendance-refresh — active non-members (ATTPROSPECTS.1)', () => {
  const TRIAL = '0000000000000000000000d4'
  const trial = (over = {}) => ({ id: 'c-trial', glofox_member_id: TRIAL, last_attended_at: null, last_booked_at: null, ...over })
  const daysAgoSec = (d) => Math.floor((Date.now() - d * 86_400_000) / 1000)
  // mockImplementation outlives vi.clearAllMocks(): put the default back.
  afterEach(async () => {
    const { fetchUserBookingsResult } = await import('@/lib/glofox')
    fetchUserBookingsResult.mockImplementation(async () => ({ ok: true, bookings: [] }))
  })

  it('refreshes an active trial\'s counts from its bookings, with no member read', async () => {
    const { fetchUserBookingsResult } = await import('@/lib/glofox')
    h.prospects = [trial()]
    fetchUserBookingsResult.mockImplementation(async (_c, gid) => (gid === TRIAL
      ? { ok: true, bookings: [{ _id: 'b1', created: daysAgoSec(3), time_start: daysAgoSec(2), attended: true, status: 'BOOKED' }] }
      : { ok: true, bookings: [] }))
    const out = await (await GET(req())).json()

    const patch = patchFor('c-trial')
    expect(patch).toMatchObject({ total_attended_30d: 1, total_attended_7d: 1, total_bookings_30d: 1 })
    expect(patch.last_attended_at).toEqual(expect.any(String))
    expect(patch.recent_bookings).toHaveLength(1)
    for (const k of MEMBER_READ_KEYS) expect(patch).not.toHaveProperty(k)
    expect(fetch.mock.calls.map(([u]) => String(u)).some((u) => u.includes(TRIAL))).toBe(false)
    expect(out.per_location[0].prospects).toEqual({ eligible: 1, refreshed: 1, fetch_failed: 0, update_failed: 0 })
  })

  it('asks only for active non-members, never members or ClassPass', async () => {
    await GET(req())
    expect(h.prospectQueries).toHaveLength(1)
    const { notIn, or } = h.prospectQueries[0]
    expect(notIn).toBe('(member,credit_member,classpass_payg)')
    for (const f of ['last_booked_at.gte.', 'last_attended_at.gte.', 'total_bookings_30d.gt.0', 'total_attended_30d.gt.0', 'total_attended_7d.gt.0', 'total_noshow_30d.gt.0']) {
      expect(or).toContain(f)
    }
    // A day string: the or() grammar reserves '.' and ':', so no instant.
    expect(or).toMatch(/last_booked_at\.gte\.\d{4}-\d{2}-\d{2},/)
  })

  it('runs before the members, so a long member run cannot starve it', async () => {
    const { fetchUserBookingsResult } = await import('@/lib/glofox')
    h.prospects = [trial()]
    await GET(req())
    expect(fetchUserBookingsResult.mock.calls[0][1]).toBe(TRIAL)
  })

  it('never wipes a stored date: an empty 30-day window decays the counts only', async () => {
    h.prospects = [trial({ last_attended_at: '2026-08-01T09:00:00.000Z', last_booked_at: '2026-07-30T09:00:00.000Z' })]
    await GET(req())
    const patch = patchFor('c-trial')
    expect(patch).toMatchObject({ total_attended_30d: 0, total_attended_7d: 0, total_bookings_30d: 0, total_noshow_30d: 0 })
    expect(patch).not.toHaveProperty('last_attended_at')
    expect(patch).not.toHaveProperty('last_booked_at')
    expect(patch).not.toHaveProperty('recent_bookings')
  })

  it('a failed bookings read writes nothing for that contact and is counted', async () => {
    const { fetchUserBookingsResult } = await import('@/lib/glofox')
    h.prospects = [trial()]
    fetchUserBookingsResult.mockImplementation(async (_c, gid) => (gid === TRIAL ? { ok: false, bookings: [] } : { ok: true, bookings: [] }))
    await GET(req())
    expect(patchFor('c-trial')).toBeUndefined()
    const [, outcome] = stampHeartbeat.mock.calls.at(-1)
    expect(outcome.prospects).toEqual({ eligible: 1, refreshed: 0, fetch_failed: 1, update_failed: 0 })
  })
})

// GLOFOXREADERS.1 — Glofox members whose contact lives at a sibling studio.
describe('GET /api/cron/glofox-attendance-refresh — crossover contacts (GLOFOXREADERS.1)', () => {
  it('no crossover contacts: the member list keeps its plain studio filter', async () => {
    await GET(req())
    expect(h.memberScopes).toEqual([null])
  })

  it('crossover contacts widen the member list to "lives here, or is linked here"', async () => {
    h.crossover = [{ contact_id: 'c-hatch-1' }, { contact_id: 'c-hatch-2' }]
    await GET(req())
    expect(h.memberScopes).toEqual(['location_id.eq.loc-1,id.in.(c-hatch-1,c-hatch-2)'])
  })
})
