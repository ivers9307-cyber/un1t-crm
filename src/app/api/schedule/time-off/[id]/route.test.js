// ROSTER-FIX.2 — authorisation tests for PUT /api/schedule/time-off/[id].
//
// The old gate was role-only: any manager, at any studio, could cancel any
// request; and a manager could approve their OWN leave because the self
// branch fell through to the MANAGER_ROLES escape hatch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// LEAVECANCEL.1 — the ask notice runs inside after() (next/server), the
// SWAPNOTIFY.1 pattern: keep the real NextResponse, run the callback at once.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn((u) => (u.locations ? u.locations.map((l) => l.id) : ['loc-1'])),
    // SCHEDROLES.1 — REAL: the role at the request's studio is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { after } = await import('next/server')
const { logError } = await import('@/lib/log')
const { PUT } = await import('./route.js')
const { fakeDb, queriesOf, resolveLocations, scopedAssignments, locationScopeOf } = await import('@/lib/time-off.test-helpers')

const PROPS = { params: Promise.resolve({ id: 'a0000000-0000-4000-8000-00000000000e' }) }

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// LEAVE.2 — the route now also reads the requester's studios, their
// employment type, the allowance (to seed it) and their shifts (clashes).
function buildDb({
  existing,
  requesterLocations = [existing?.location_id].filter(Boolean),
  employmentType = 'fte',
  allowance = null,
  entitlement = null,
  assignments = [],
  // LEAVECANCEL.1 — who could decide a cancellation (owner links at the
  // request's studios, the estate's masters), what a re-read after a lost race
  // finds, and whether the guarded ask UPDATE matches a row at all.
  owners = [],
  masters = [],
  ownersError = null,
  reread = null,
  askMatches = true,
  // What the guarded ask UPDATE answers when it fails.
  askError = null,
  // What the status PUT's .single() UPDATE answers when it fails.
  updateError = null,
  readError = null,
}) {
  const updateSpy = vi.fn()
  const allowanceInsertSpy = vi.fn()
  let reads = 0
  const db = fakeDb((q) => {
    if (q.table === 'time_off_requests' && q.action === 'select') {
      reads += 1
      if (readError) return { data: null, error: readError }
      const row = reads > 1 && reread ? reread : existing
      // A read that asks for the people embeds gets them, so a test can tell
      // the full answer shape from a bare row.
      const withPeople = row && String(q.columns || '').includes('profiles!profile_id')
      return { data: withPeople ? { ...row, profiles: { id: row.profile_id, full_name: 'Mia Manager' } } : row, error: null }
    }
    if (q.table === 'time_off_requests' && q.action === 'update') {
      updateSpy(q.payload)
      // The status PUT ends in .single(); the guarded ask UPDATE returns the
      // rows it touched, and a zero-row UPDATE is [] with no error.
      if (q.terminal === 'single') return updateError ? { data: null, error: updateError } : { data: { ...existing, ...q.payload }, error: null }
      if (askError) return { data: null, error: askError }
      return { data: askMatches ? [{ ...existing, ...q.payload }] : [], error: null }
    }
    if (q.table === 'profile_locations' && q.eq.role === 'owner') {
      return ownersError
        ? { data: null, error: ownersError }
        : { data: owners.map((profile_id) => ({ profile_id, location_id: existing.location_id, role: 'owner', profiles: { id: profile_id, role: 'staff', active: true, deleted_at: null } })), error: null }
    }
    if (q.table === 'profile_locations') return { data: requesterLocations.map((location_id) => ({ location_id })), error: null }
    if (q.table === 'profiles' && q.eq.role === 'master') return { data: masters.map((id) => ({ id })), error: null }
    if (q.table === 'profiles') return { data: { employment_type: employmentType }, error: null }
    if (q.table === 'staff_allowances' && q.action === 'select') return { data: allowance, error: null }
    if (q.table === 'staff_allowances' && q.action === 'insert') { allowanceInsertSpy(q.payload); return { data: null, error: null } }
    if (q.table === 'profile_compensation') return { data: entitlement == null ? null : { annual_leave_entitlement: entitlement }, error: null }
    // ORGSCOPE.1 — loc-1 + loc-2 are one organisation; loc-x is another's.
    if (q.table === 'locations') return resolveLocations(q, { 'loc-1': 'org-1', 'loc-2': 'org-1', 'loc-x': 'org-x' })
    if (q.table === 'shift_assignments') return scopedAssignments(q, assignments)
    throw new Error(`unexpected ${q.table}/${q.action}`)
  })
  return { db, updateSpy, allowanceInsertSpy }
}

beforeEach(() => {
  createServerClient.mockReset(); getCurrentUser.mockReset(); notifyUsersOnce.mockClear(); after.mockClear()
  hasPermissionForLocation.mockImplementation(() => true)
  // Requests below run 1-2 Jun 2026; "today" is before them, so none has expired.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-05-20T10:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('PUT /api/schedule/time-off/[id] — authorisation', () => {
  // LEAVECANCEL.1 (review) — a malformed id reached Postgres and came back as
  // a 500 with raw text (22P02, invalid input syntax for type uuid). It is the
  // same 404 as a missing id, decided before any read.
  it('a malformed id is the same 404 as a missing one, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
    const { db } = buildDb({ existing: { id: 'x', profile_id: 'c', location_id: 'loc-1', status: 'pending' } })
    createServerClient.mockReturnValue(db)
    for (const id of ['not-a-uuid', "1' or '1'='1", '']) {
      const res = await PUT(req({ status: 'cancelled' }), { params: Promise.resolve({ id }) })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe('Request not found')
    }
    expect(db.queries).toHaveLength(0)
  })

  it('a manager at another location cannot cancel', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'c', location_id: 'loc-2', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a manager cannot approve their own request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'manager', profileRole: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a coach may cancel their own pending request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } })
    const { db } = buildDb({ existing: { id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
  })

  it('a coach may not cancel an approved request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'c', location_id: 'loc-1', status: 'approved', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})

// SCHEDROLES.1 — head coach at loc-1, plain staff at loc-2. The route read
// `user.role` (the ACTIVE studio's) plus membership, so this caller could
// cancel a loc-2 colleague's leave from a loc-1 session.
describe('PUT /api/schedule/time-off/[id] — role at the request\'s studio (SCHEDROLES.1)', () => {
  const mixed = (active, id = 'mix') => ({
    id, role: active === 'loc-1' ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
    rolesByLocation: { 'loc-1': 'head_coach', 'loc-2': 'staff' },
  })
  const row = (location_id, profile_id = 'colleague', status = 'pending') => ({
    id: 'a0000000-0000-4000-8000-00000000000e', profile_id, location_id, status, type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02',
  })

  it('refuses a colleague\'s request at the studio where the caller is staff (404, nothing written)', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, updateSpy } = buildDb({ existing: row('loc-2') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('allows a colleague\'s request at the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, updateSpy } = buildDb({ existing: row('loc-1') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-2'))
    const { db } = buildDb({ existing: row('loc-1') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
  })

  it('the same caller may still cancel their OWN pending request at the studio where they are staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db } = buildDb({ existing: row('loc-2', 'mix') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
  })

  it('...but not reopen their own APPROVED request there, which only a manager of that studio could', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, updateSpy } = buildDb({ existing: row('loc-2', 'mix', 'approved') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('master is allowed at any studio', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    const { db } = buildDb({ existing: row('loc-2') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
  })
})


// LEAVE.2 — the decision now judges the PERSON's studios, refuses an expired
// request, refuses a contractor's non-unavailable leave, seeds the allowance
// from the entitlement and reports rostered-shift clashes.
describe('PUT /api/schedule/time-off/[id] — LEAVE.2', () => {
  const HC = (locs, id = 'hc') => ({
    id, role: 'head_coach', profileRole: 'staff',
    locations: locs.map((l) => ({ id: l })),
    rolesByLocation: Object.fromEntries(locs.map((l) => [l, 'head_coach'])),
  })
  const row = (over = {}) => ({
    id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'coach', location_id: 'loc-1', status: 'pending', type: 'holiday',
    start_date: '2026-06-01', end_date: '2026-06-02', total_days: 2, ...over,
  })

  it('a head coach at the requester\'s OTHER studio can decide leave filed at the first', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-2']))
    const { db, updateSpy } = buildDb({ existing: row(), requesterLocations: ['loc-1', 'loc-2'] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('...but not when the requester does not belong to the caller\'s studio (404)', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-2']))
    const { db, updateSpy } = buildDb({ existing: row(), requesterLocations: ['loc-1'] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('403 without the time-off approval permission', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    hasPermissionForLocation.mockImplementation(() => false)
    const { db, updateSpy } = buildDb({ existing: row() })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('409 approving a pending request whose end date has passed; it can still be declined', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'))
    let { db, updateSpy } = buildDb({ existing: row() })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/expired/)
    expect(updateSpy).not.toHaveBeenCalled()

    ;({ db, updateSpy } = buildDb({ existing: row() }))
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'rejected' }), PROPS)).status).toBe(200)
  })

  it('400 approving holiday for a contractor, and no allowance is created', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, updateSpy, allowanceInsertSpy } = buildDb({ existing: row(), employmentType: 'contractor' })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Contractors/)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(allowanceInsertSpy).not.toHaveBeenCalled()
  })

  it('approves a contractor\'s unavailable leave without touching allowances', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, allowanceInsertSpy } = buildDb({ existing: row({ type: 'unavailable' }), employmentType: 'contractor' })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(allowanceInsertSpy).not.toHaveBeenCalled()
  })

  it('seeds the first allowance of the year from the entitlement before approving a holiday', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, allowanceInsertSpy } = buildDb({ existing: row(), entitlement: 15 })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(allowanceInsertSpy).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 'coach', year: 2026, total_days: 15, used_days: 0 }))
  })

  it('never rewrites an existing allowance row', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, allowanceInsertSpy } = buildDb({ existing: row(), entitlement: 15, allowance: { id: 'a', total_days: 20, used_days: 3, carried_over: 0 } })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(allowanceInsertSpy).not.toHaveBeenCalled()
  })

  it('returns the live shifts the leave clashes with, and does not unassign them', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const block = (id, date, location_id = 'loc-1') => ({ id, block_date: date, start_time: '09:00:00', end_time: '10:00:00', location_id, rosters: { status: 'published' }, shift_templates: { name: 'AM' }, locations: { name: 'Stillorgan' } })
    const { db } = buildDb({
      existing: row({ type: 'unavailable' }),
      assignments: [
        { id: 'a1', profile_id: 'coach', status: 'scheduled', shift_blocks: block('b1', '2026-06-01') },
        { id: 'a2', profile_id: 'coach', status: 'cancelled', shift_blocks: block('b2', '2026-06-02') },
        { id: 'a3', profile_id: 'coach', status: 'confirmed', shift_blocks: block('b3', '2026-06-02', 'loc-2') },
      ],
    })
    createServerClient.mockReturnValue(db)
    const json = await (await PUT(req({ status: 'approved' }), PROPS)).json()
    expect(json.clashes.map((c) => c.id)).toEqual(['a1', 'a3'])
    expect(queriesOf(db, 'shift_assignments', 'delete')).toHaveLength(0)
  })

  // ORGSCOPE.1 — the coach is also on staff at loc-x, another organisation.
  const orgBlock = (id, location_id, name) => ({ id, block_date: '2026-06-01', start_time: '09:00:00', end_time: '10:00:00', location_id, rosters: { status: 'published' }, shift_templates: { name }, locations: { name: `Studio ${location_id}` } })
  const ORG_SHIFTS = [
    { id: 'a1', profile_id: 'coach', status: 'scheduled', shift_blocks: orgBlock('b1', 'loc-1', 'AM') },
    { id: 'ax', profile_id: 'coach', status: 'scheduled', shift_blocks: orgBlock('bx', 'loc-x', 'Other org shift') },
  ]

  it('approving never shows the coach\'s shifts at another organisation\'s studio', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db } = buildDb({ existing: row({ type: 'unavailable' }), requesterLocations: ['loc-1', 'loc-x'], assignments: ORG_SHIFTS })
    createServerClient.mockReturnValue(db)
    const json = await (await PUT(req({ status: 'approved' }), PROPS)).json()
    expect(json.clashes.map((c) => c.id)).toEqual(['a1'])
    expect(JSON.stringify(json)).not.toContain('Other org shift')
  })

  it('an approver entitled only at the other organisation\'s studio is shown that organisation alone, not where the leave was filed', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-x']))
    const { db } = buildDb({ existing: row({ type: 'unavailable' }), requesterLocations: ['loc-1', 'loc-x'], assignments: ORG_SHIFTS })
    createServerClient.mockReturnValue(db)
    const json = await (await PUT(req({ status: 'approved' }), PROPS)).json()
    expect(locationScopeOf(queriesOf(db, 'shift_assignments')[0])).toEqual(['loc-x'])
    expect(json.clashes.map((c) => c.id)).toEqual(['ax'])
  })
})

// LEAVECANCEL.1 — the owner's rule (20 Sep 2026): a manager cancelling their
// OWN APPROVED leave needs an owner's approval. The PUT used to let any
// manager-tier requester straight through. It now RECORDS THE ASK and leaves
// the leave approved; POST ./cancel-request decides it.
describe('PUT /api/schedule/time-off/[id] — cancelling your own APPROVED leave (LEAVECANCEL.1)', () => {
  const at = (id, role, profileRole = 'staff') => ({
    id, role, profileRole, full_name: 'Mia Manager',
    locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': role },
  })
  const own = (over = {}) => ({
    id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'me', location_id: 'loc-1', status: 'approved', type: 'holiday',
    start_date: '2026-06-01', end_date: '2026-06-02', total_days: 2,
    cancel_requested_at: null, cancel_requested_by: null, cancel_decided_at: null, cancel_decision: null,
    ...over,
  })
  const OPEN = { cancel_requested_at: '2026-05-19T09:00:00.000Z', cancel_requested_by: 'me' }

  it('a manager\'s cancel records the ask, tells the owners, and LEAVES THE LEAVE APPROVED', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own(), owners: ['own-1', 'own-2'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled', cancel_request_note: 'Trip fell through' }), PROPS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, cancellation: 'requested' })
    expect(json.data.status).toBe('approved')

    // The write never names `status`: every reader of status='approved' is untouched.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const payload = updateSpy.mock.calls[0][0]
    expect(payload).not.toHaveProperty('status')
    expect(payload).toMatchObject({
      cancel_requested_by: 'me', cancel_request_note: 'Trip fell through',
      cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
    })
    expect(payload.cancel_requested_at).toBe('2026-05-20T10:00:00.000Z')

    // Guarded so it cannot land on leave that stopped being approved, or on top of an open ask.
    const write = queriesOf(db, 'time_off_requests', 'update')[0]
    expect(write.calls).toContainEqual(['eq', 'id', 'a0000000-0000-4000-8000-00000000000e'])
    expect(write.calls).toContainEqual(['eq', 'status', 'approved'])
    expect(write.calls).toContainEqual(['or', 'cancel_requested_at.is.null,cancel_decided_at.not.is.null'])

    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [, key, recipients, notice] = notifyUsersOnce.mock.calls[0]
    // One notice per leave per hour (cancelAskNoticeKey), sent from after().
    expect(key).toBe('time_off_cancel_ask:a0000000-0000-4000-8000-00000000000e:2026-05-20T10')
    expect(recipients).toEqual(['own-1', 'own-2'])
    expect(notice).toMatchObject({ category: 'time_off', data: { type: 'time_off_cancel_request', request_id: 'a0000000-0000-4000-8000-00000000000e', start_date: '2026-06-01' } })
    expect(`${notice.title} ${notice.body}`).not.toMatch(/—/)
    // The phone has nowhere to decide this, so the push says where to go.
    expect(notice.body).toMatch(/Decide it on the Time Off page on the web\.$/)
    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.calls[0][0]).toBeInstanceOf(Function)
  })

  it('a head coach must ask too', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'head_coach'))
    const { db, updateSpy } = buildDb({ existing: own(), owners: ['own-1'] })
    createServerClient.mockReturnValue(db)
    expect((await (await PUT(req({ status: 'cancelled' }), PROPS)).json()).cancellation).toBe('requested')
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('status')
  })

  it('asking again while one is open is idempotent: nothing written, nobody told twice', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own(OPEN), owners: ['own-1'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, cancellation: 'requested', already_requested: true })
    // Same shape as the first answer: the row WITH its people embeds.
    expect(json.data.profiles).toEqual({ id: 'me', full_name: 'Mia Manager' })
    expect(updateSpy).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('a day after a decline the person may ask again, and the old answer is cleared', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const declined = own({ ...OPEN, cancel_requested_at: '2026-05-18T09:00:00.000Z', cancel_decided_at: '2026-05-19T09:59:00.000Z', cancel_decided_by: 'own-1', cancel_decision: 'rejected' })
    const { db, updateSpy } = buildDb({ existing: declined, owners: ['own-1'] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ cancel_decided_at: null, cancel_decision: null })
    expect(notifyUsersOnce.mock.calls[0][1]).toBe('time_off_cancel_ask:a0000000-0000-4000-8000-00000000000e:2026-05-20T10')
  })

  it('...but NOT within 24h of the decline: every ask pages every owner (409, nothing written, nobody told)', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const declined = own({ ...OPEN, cancel_decided_at: '2026-05-19T12:00:00.000Z', cancel_decided_by: 'own-1', cancel_decision: 'rejected' })
    const { db, updateSpy } = buildDb({ existing: declined, owners: ['own-1'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/declined this less than a day ago/)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('an OWNER asks too, and only a DIFFERENT owner is told', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'owner'))
    const { db } = buildDb({ existing: own(), owners: ['me', 'own-2'] })
    createServerClient.mockReturnValue(db)
    expect((await (await PUT(req({ status: 'cancelled' }), PROPS)).json()).cancellation).toBe('requested')
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['own-2'])
  })

  // On main a sole owner could cancel their own approved leave outright. A
  // refusal would be a new dead end, and the owner-less manager case already
  // routes to masters: "someone else must approve" still holds.
  it('a SOLE owner\'s ask is recorded and goes to the masters, exactly like a manager at a studio with no owner', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'owner'))
    const { db, updateSpy } = buildDb({ existing: own(), owners: ['me'], masters: ['boss', 'me'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).cancellation).toBe('requested')
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('status')
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['boss'])
  })

  it('...and is refused only when there is truly nobody else: no other owner and no master but themselves', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'owner'))
    const { db, updateSpy } = buildDb({ existing: own(), owners: ['me'], masters: ['me'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/nobody else/i)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('a manager at a studio with NO owner: the ask is recorded and the masters are told', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own(), owners: [], masters: ['boss'] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(notifyUsersOnce.mock.calls[0][2]).toEqual(['boss'])
  })

  it('...and with no owner and no master either, it is refused rather than parked where nobody will see it', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own(), owners: [], masters: [] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(409)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('an unreadable owner list fails closed: 500, nothing written', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own(), ownersError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(500)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a MASTER still cancels their own approved leave directly', async () => {
    getCurrentUser.mockResolvedValue({ id: 'me', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    const { db, updateSpy } = buildDb({ existing: own(), owners: ['own-1'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).cancellation).toBeUndefined()
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ status: 'cancelled' })
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('a manager\'s own PENDING request still cancels directly (nothing was approved, nothing to ask about)', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own({ status: 'pending' }) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ status: 'cancelled' })
  })

  it('leave whose last day has passed cannot be asked about (409); leave that has only STARTED can', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    vi.setSystemTime(new Date('2026-06-03T10:00:00Z'))
    let { db, updateSpy } = buildDb({ existing: own(), owners: ['own-1'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ended on 2026-06-02/)
    expect(updateSpy).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-06-02T10:00:00Z'))
    ;({ db, updateSpy } = buildDb({ existing: own(), owners: ['own-1'] }))
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it('a lost race (the guarded UPDATE touched no row): an ask that is now open is a success, anything else is a 409', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    let { db } = buildDb({ existing: own(), owners: ['own-1'], askMatches: false, reread: own(OPEN) })
    createServerClient.mockReturnValue(db)
    let res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
    const raced = await res.json()
    expect(raced).toMatchObject({ cancellation: 'requested', already_requested: true })
    expect(raced.data.profiles).toEqual({ id: 'me', full_name: 'Mia Manager' })
    expect(notifyUsersOnce).not.toHaveBeenCalled()

    ;({ db } = buildDb({ existing: own(), owners: ['own-1'], askMatches: false, reread: own({ status: 'cancelled' }) }))
    createServerClient.mockReturnValue(db)
    res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(409)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  // LEAVECANCEL.1 (review) — before mig 624 is applied (a Vercel preview, an
  // ordering slip) the ask write names columns PostgREST does not have. The
  // list GET hides the button then (CANCEL_ASK_OFF), so this is a stale screen
  // or a hand-made request: a clear message, a loud log, and nobody told.
  it('before mig 624: the ask write is refused plainly (503), logged, and nobody is told', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    logError.mockClear()
    const { db } = buildDb({
      existing: own(), owners: ['own-1'],
      askError: { code: 'PGRST204', message: "Could not find the 'cancel_decided_at' column of 'time_off_requests' in the schema cache" },
    })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.error).toMatch(/not available yet/)
    expect(json.error).toMatch(/still approved/)
    expect(json.error).not.toMatch(/schema cache|—/)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][1]).toMatch(/mig 624/)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('...while any other failed ask write is still the 400 it was', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db } = buildDb({ existing: own(), owners: ['own-1'], askError: { code: '57014', message: 'timeout' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('timeout')
  })

  it('a failed notice never fails the ask', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    notifyUsersOnce.mockImplementationOnce(() => Promise.reject(new Error('expo down')))
    const { db } = buildDb({ existing: own(), owners: ['own-1'] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
  })

  it('the side door is shut: a manager cannot put their own approved leave back to pending', async () => {
    getCurrentUser.mockResolvedValue(at('me', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own() })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'pending' }), PROPS)).status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a colleague\'s approved leave is unchanged by this rule: a manager there still cancels it directly', async () => {
    getCurrentUser.mockResolvedValue(at('other-mgr', 'manager'))
    const { db, updateSpy } = buildDb({ existing: own() })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ status: 'cancelled' })
  })
})

// LEAVECANCEL.1 (review) — an ask is ABOUT a state: "this approved leave,
// please cancel it". When a colleague moves the leave out of that state through
// the plain PUT, the ask dies with it. Left on the row it was only "lapsed",
// and a later re-approval made it OPEN again: back in the owners' queue, where
// an owner could cancel reinstated leave nobody had asked about.
describe('PUT /api/schedule/time-off/[id] — an ask dies with the state it was about (LEAVECANCEL.1)', () => {
  const colleague = (role = 'manager') => ({
    id: 'other', role, profileRole: 'staff', full_name: 'Colm Colleague',
    locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': role },
  })
  const theirs = (over = {}) => ({
    id: 'a0000000-0000-4000-8000-00000000000e', profile_id: 'mgr', location_id: 'loc-1', status: 'approved', type: 'unavailable',
    start_date: '2026-06-01', end_date: '2026-06-02', total_days: 2,
    cancel_requested_at: '2026-05-19T09:00:00.000Z', cancel_requested_by: 'mgr', cancel_request_note: 'Trip fell through',
    cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
    ...over,
  })
  const CLEARED = {
    cancel_requested_at: null, cancel_requested_by: null, cancel_request_note: null,
    cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
  }

  for (const status of ['cancelled', 'rejected', 'pending']) {
    it(`route 1: a colleague moves the leave to ${status} while an ask is open, and the ask is cleared in the same guarded write`, async () => {
      getCurrentUser.mockResolvedValue(colleague())
      const { db, updateSpy } = buildDb({ existing: theirs() })
      createServerClient.mockReturnValue(db)
      expect((await PUT(req({ status }), PROPS)).status).toBe(200)
      expect(updateSpy.mock.calls[0][0]).toMatchObject({ status, ...CLEARED })
      // Guarded on the status it read: it must not land on top of an owner's
      // decision made a moment ago.
      expect(queriesOf(db, 'time_off_requests', 'update')[0].calls).toContainEqual(['eq', 'status', 'approved'])
    })
  }

  it('route 2 (the second lock): re-approving a row that still carries an undecided ask clears it, so it cannot reopen', async () => {
    getCurrentUser.mockResolvedValue(colleague())
    // A row from before this fix, or written by any other route: cancelled,
    // with the ask columns still set.
    const { db, updateSpy } = buildDb({ existing: theirs({ status: 'cancelled' }) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ status: 'approved', ...CLEARED })
  })

  it('re-approving leave whose cancellation an owner APPROVED clears it too (mig 624\'s CHECK would refuse the row otherwise)', async () => {
    getCurrentUser.mockResolvedValue(colleague('owner'))
    const done = theirs({ status: 'cancelled', cancel_decided_at: '2026-05-19T12:00:00.000Z', cancel_decided_by: 'own-1', cancel_decision: 'approved' })
    const { db, updateSpy } = buildDb({ existing: done })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ status: 'approved', ...CLEARED })
  })

  it('an approver re-stamping leave that is STILL approved does not touch the ask: nothing about its state changed', async () => {
    getCurrentUser.mockResolvedValue(colleague())
    const { db, updateSpy } = buildDb({ existing: theirs() })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('cancel_requested_at')
  })

  it('a row with no ask is written exactly as before: no clear, no status guard', async () => {
    getCurrentUser.mockResolvedValue(colleague())
    const { db, updateSpy } = buildDb({ existing: theirs({ cancel_requested_at: null, cancel_requested_by: null, cancel_request_note: null }) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('cancel_requested_at')
    expect(queriesOf(db, 'time_off_requests', 'update')[0].calls).toEqual([['eq', 'id', 'a0000000-0000-4000-8000-00000000000e']])
  })

  it('leave an owner has ALREADY cancelled cannot then be rejected or reopened from a stale screen: a calm 409, nothing written', async () => {
    getCurrentUser.mockResolvedValue(colleague())
    const done = theirs({ status: 'cancelled', cancel_decided_at: '2026-05-19T12:00:00.000Z', cancel_decided_by: 'own-1', cancel_decision: 'approved' })
    for (const status of ['rejected', 'pending']) {
      const { db, updateSpy } = buildDb({ existing: done })
      createServerClient.mockReturnValue(db)
      const res = await PUT(req({ status }), PROPS)
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe('This leave was already cancelled.')
      expect(updateSpy).not.toHaveBeenCalled()
    }
  })

  it('the true race (the owner\'s approval lands between this PUT\'s read and its write) is a 409 too, never raw constraint text', async () => {
    getCurrentUser.mockResolvedValue(colleague())
    // The guarded write matched no row: .single() answers PGRST116.
    let built = buildDb({ existing: theirs(), updateError: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } })
    createServerClient.mockReturnValue(built.db)
    let res = await PUT(req({ status: 'rejected' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/changed a moment ago/)

    // No ask on the row this PUT read, so no guard: the CHECK is what refuses.
    built = buildDb({
      existing: theirs({ cancel_requested_at: null, cancel_requested_by: null, cancel_request_note: null }),
      updateError: { code: '23514', message: 'new row for relation "time_off_requests" violates check constraint "time_off_requests_cancel_approved_is_cancelled"' },
    })
    createServerClient.mockReturnValue(built.db)
    res = await PUT(req({ status: 'rejected' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This leave was already cancelled.')
  })

  it('a FAILED read of the request is a 500, not "Request not found" (the error used to be discarded)', async () => {
    getCurrentUser.mockResolvedValue(colleague())
    const { db, updateSpy } = buildDb({ existing: theirs(), readError: { message: 'connection reset' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(500)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('any other failed write is still the 400 it always was', async () => {
    getCurrentUser.mockResolvedValue(colleague())
    const { db } = buildDb({ existing: theirs({ cancel_requested_at: null, cancel_requested_by: null }), updateError: { code: '42P01', message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('boom')
  })
})
