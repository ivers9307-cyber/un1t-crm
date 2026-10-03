// LEAVE.1 — POST /api/schedule/time-off/[id]/unassign-clashes: the explicit
// "Unassign them" after approving leave. Gates: can decide the request (404),
// approved (409), manager at each shift's studio (skipped). Removal goes
// through unassignShiftAssignments — the helper the assignment DELETE uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { getCurrentUser: vi.fn(), hasRoleAtLocation: real.hasRoleAtLocation }
})
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/shift-unassign', () => ({
  unassignShiftAssignments: vi.fn(async (_db, { assignments }) => ({ removed: assignments, failed: [] })),
  SHIFT_CHANGED_ERROR: 'This shift has just changed. Refresh and try again.',
  SHIFTS_CHANGED_ERROR: 'These shifts have just changed. Refresh and try again.',
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { unassignShiftAssignments } = await import('@/lib/shift-unassign')
const { POST } = await import('./route.js')
const { fakeDb, queriesOf, resolveLocations, scopedAssignments, locationScopeOf } = await import('@/lib/time-off.test-helpers')

const PROPS = { params: Promise.resolve({ id: 'req-1' }) }
const req = (body = {}) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })

const HC = { id: 'hc', role: 'head_coach', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'head_coach' } }
const block = (id, date, location_id) => ({ id, block_date: date, start_time: '09:00:00', end_time: '10:00:00', location_id, rosters: { status: 'published' }, shift_templates: { name: 'AM' }, locations: { name: location_id } })

// ORGSCOPE.1 — loc-1 + loc-2 are one organisation; loc-x is another's studio.
// The shift read honours its location filter, so an open read shows as a leak.
const ORGS = { 'loc-1': 'org-1', 'loc-2': 'org-1', 'loc-x': 'org-x' }

function buildDb({ leave, requesterLocations = ['loc-1'], assignments = [] }) {
  return fakeDb((q) => {
    if (q.table === 'time_off_requests') return { data: leave, error: null }
    if (q.table === 'profile_locations') return { data: requesterLocations.map((location_id) => ({ location_id })), error: null }
    if (q.table === 'locations') return resolveLocations(q, ORGS)
    if (q.table === 'shift_assignments') return scopedAssignments(q, assignments)
    throw new Error(q.table)
  })
}

const LEAVE = { id: 'req-1', profile_id: 'coach', location_id: 'loc-1', status: 'approved', type: 'unavailable', start_date: '2026-06-01', end_date: '2026-06-03' }
const ASSIGNMENTS = [
  { id: 'a1', profile_id: 'coach', status: 'scheduled', shift_blocks: block('b1', '2026-06-01', 'loc-1') },
  { id: 'a2', profile_id: 'coach', status: 'scheduled', shift_blocks: block('b2', '2026-06-02', 'loc-2') },
  { id: 'a3', profile_id: 'coach', status: 'cancelled', shift_blocks: block('b3', '2026-06-03', 'loc-1') },
]

beforeEach(() => {
  vi.clearAllMocks()
  hasPermissionForLocation.mockImplementation(() => true)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-05-20T10:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('POST /api/schedule/time-off/[id]/unassign-clashes', () => {
  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req(), PROPS)).status).toBe(401)
  })

  it('404 when the caller cannot decide the request', async () => {
    getCurrentUser.mockResolvedValue(HC)
    hasPermissionForLocation.mockImplementation(() => false)
    createServerClient.mockReturnValue(buildDb({ leave: LEAVE, assignments: ASSIGNMENTS }))
    expect((await POST(req(), PROPS)).status).toBe(404)
    expect(unassignShiftAssignments).not.toHaveBeenCalled()
  })

  it('409 for leave that is not approved', async () => {
    getCurrentUser.mockResolvedValue(HC)
    createServerClient.mockReturnValue(buildDb({ leave: { ...LEAVE, status: 'pending' }, assignments: ASSIGNMENTS }))
    expect((await POST(req(), PROPS)).status).toBe(409)
    expect(unassignShiftAssignments).not.toHaveBeenCalled()
  })

  it('removes live clashes at studios the caller manages; skips the rest', async () => {
    getCurrentUser.mockResolvedValue(HC)
    createServerClient.mockReturnValue(buildDb({ leave: LEAVE, requesterLocations: ['loc-1', 'loc-2'], assignments: ASSIGNMENTS }))
    const res = await POST(req(), PROPS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(unassignShiftAssignments).toHaveBeenCalledTimes(1)
    const passed = unassignShiftAssignments.mock.calls[0][1]
    expect(passed.actorId).toBe('hc')
    expect(passed.assignments.map((a) => a.id)).toEqual(['a1'])
    expect(passed.assignments[0]).toMatchObject({ block_id: 'b1', block_date: '2026-06-01', location_id: 'loc-1', roster_status: 'published' })
    expect(json.data.skipped).toEqual([expect.objectContaining({ assignment_id: 'a2', reason: 'not_manager_at_location' })])
  })

  // ORGSCOPE.1 — the coach is also on staff at loc-x, another organisation.
  it('never reads or reports the coach\'s shifts at another organisation\'s studio', async () => {
    getCurrentUser.mockResolvedValue(HC)
    const db = buildDb({
      leave: LEAVE,
      requesterLocations: ['loc-1', 'loc-x'],
      assignments: [...ASSIGNMENTS, { id: 'ax', profile_id: 'coach', status: 'scheduled', shift_blocks: block('bx', '2026-06-02', 'loc-x') }],
    })
    createServerClient.mockReturnValue(db)
    const json = await (await POST(req(), PROPS)).json()
    expect(locationScopeOf(queriesOf(db, 'shift_assignments')[0]).sort()).toEqual(['loc-1', 'loc-2'])
    expect(JSON.stringify(json)).not.toContain('loc-x')
    expect(json.data.skipped.map((x) => x.assignment_id)).toEqual(['a2'])
  })

  it('scopes from where the CALLER decides: entitled only at the other organisation\'s studio, they get that organisation alone', async () => {
    getCurrentUser.mockResolvedValue({ id: 'hx', role: 'head_coach', profileRole: 'staff', locations: [{ id: 'loc-x' }], rolesByLocation: { 'loc-x': 'head_coach' } })
    const db = buildDb({ leave: LEAVE, requesterLocations: ['loc-1', 'loc-x'], assignments: ASSIGNMENTS })
    createServerClient.mockReturnValue(db)
    await POST(req(), PROPS)
    expect(locationScopeOf(queriesOf(db, 'shift_assignments')[0])).toEqual(['loc-x'])
    expect(unassignShiftAssignments.mock.calls[0][1].assignments).toEqual([])
  })

  it('honours assignment_ids — a clash the approver was not shown is left alone', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    createServerClient.mockReturnValue(buildDb({ leave: LEAVE, assignments: ASSIGNMENTS }))
    await POST(req({ assignment_ids: ['22222222-2222-4222-8222-222222222222'] }), PROPS)
    expect(unassignShiftAssignments.mock.calls[0][1].assignments).toEqual([])
  })

  it('never offers shifts that are already in the past', async () => {
    vi.setSystemTime(new Date('2026-06-02T10:00:00Z'))
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    createServerClient.mockReturnValue(buildDb({ leave: LEAVE, assignments: ASSIGNMENTS }))
    await POST(req(), PROPS)
    expect(unassignShiftAssignments.mock.calls[0][1].assignments.map((a) => a.id)).toEqual(['a2'])
  })
})

// C5 REPLACENITS.1 — the outcome's status. Every row "changed" (the roster
// moved since the approver was shown it) is a 409 "refresh", not a 500 that
// reads as our fault. A real delete error with nothing removed is still 500.
// Rows already gone (a double submit) are not failures.
describe('POST /api/schedule/time-off/[id]/unassign-clashes — outcome status (REPLACENITS.1)', () => {
  const BOSS = { id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} }
  const CHANGED = (id) => ({ id, error: 'This shift has just changed. Refresh and try again.', code: 'changed' })
  const clash = (id, block_date) => ({ id, block_date, location_name: 'loc-1' })

  beforeEach(() => {
    getCurrentUser.mockResolvedValue(BOSS)
    createServerClient.mockReturnValue(buildDb({ leave: LEAVE, assignments: ASSIGNMENTS }))
  })

  it('every row changed under the approver: 409 changed, with the rows listed', async () => {
    unassignShiftAssignments.mockResolvedValueOnce({ removed: [], failed: [CHANGED('a1'), CHANGED('a2')], gone: [] })
    const res = await POST(req(), PROPS)
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json).toMatchObject({ success: false, code: 'changed', error: 'These shifts have just changed. Refresh and try again.' })
    expect(json.data.failed.map((f) => f.id)).toEqual(['a1', 'a2'])
  })

  it('one row changed: the singular words', async () => {
    unassignShiftAssignments.mockResolvedValueOnce({ removed: [], failed: [CHANGED('a1')], gone: [] })
    const res = await POST(req(), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This shift has just changed. Refresh and try again.')
  })

  it('a real delete error among them, nothing removed: still 500 (ours), no changed code', async () => {
    unassignShiftAssignments.mockResolvedValueOnce({ removed: [], failed: [CHANGED('a1'), { id: 'a2', error: 'locked' }], gone: [] })
    const res = await POST(req(), PROPS)
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.code).toBeUndefined()
    expect(json.error).toBe('2 shifts could not be unassigned')
  })

  it('some removed, one changed: 200 with success false, as before', async () => {
    unassignShiftAssignments.mockResolvedValueOnce({ removed: [clash('a1', '2026-06-01')], failed: [CHANGED('a2')], gone: [] })
    const res = await POST(req(), PROPS)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: false, error: '1 shift could not be unassigned' })
  })

  it('rows already gone (a double submit): not failures, listed as already_removed, 200 success', async () => {
    unassignShiftAssignments.mockResolvedValueOnce({ removed: [], failed: [], gone: [clash('a1', '2026-06-01')] })
    const res = await POST(req(), PROPS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.removed).toEqual([])
    expect(json.data.already_removed).toEqual([{ assignment_id: 'a1', block_date: '2026-06-01', location_name: 'loc-1' }])
  })

  it('a helper answer with no `gone` key (the old shape) still works: already_removed is empty', async () => {
    const res = await POST(req(), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).data.already_removed).toEqual([])
  })
})
