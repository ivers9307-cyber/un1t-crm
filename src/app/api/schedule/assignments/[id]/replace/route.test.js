// src/app/api/schedule/assignments/[id]/replace/route.test.js
// REPLACE.1a — the route's contract: the manager-at-the-studio gate, the
// refusals, the conflicts confirm step, the log pair on a published roster,
// and ONE notice each, now in band or from 07:00 out of it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) } // SWAPNOTIFY.1 pattern
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/shift-replace-server', () => ({ readReplaceContext: vi.fn(), replaceShiftAssignment: vi.fn() }))
vi.mock('@/lib/swap-conflicts', () => ({ findSwapConflicts: vi.fn(async () => []) }))
vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn(async () => ({ logged: true, id: 'log-1' })) }))
vi.mock('@/lib/roster-change-notify', () => ({ notifyRosterChanges: vi.fn(async () => ({ notified: 2 })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { after } = await import('next/server')
const { getCurrentUser } = await import('@/lib/auth')
const { readReplaceContext, replaceShiftAssignment } = await import('@/lib/shift-replace-server')
const { findSwapConflicts } = await import('@/lib/swap-conflicts')
const { logRosterChange } = await import('@/lib/roster-change-log')
const { notifyRosterChanges } = await import('@/lib/roster-change-notify')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')

const MANAGER = { id: 'mgr-1', profileRole: 'manager', role: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] }
const COACH = { id: 'coach-x', profileRole: 'staff', role: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }
const MIXED = { id: 'mix-1', profileRole: 'staff', role: 'manager', rolesByLocation: { 'loc-1': 'staff', 'loc-2': 'manager' }, locations: [{ id: 'loc-1' }, { id: 'loc-2' }] }
const OUTSIDER = { id: 'out-1', profileRole: 'manager', role: 'manager', rolesByLocation: { 'loc-9': 'manager' }, locations: [{ id: 'loc-9' }] }

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  rosters: { status: 'published' }, shift_templates: { name: 'Morning' }, locations: { name: 'Studio North', timezone: 'Europe/Dublin' },
}
const ctx = (over = {}) => ({
  error: null,
  assignment: { id: 'as-1', profile_id: 'coach-a', block_id: 'b1', status: 'scheduled', arrived_at: null, start_time_override: null, profiles: { full_name: 'Coach A' } },
  block: BLOCK,
  toIsMember: true,
  toProfile: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null },
  liveOnBlockIds: ['coach-a'],
  ...over,
})
const req = (body) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })
const A_ID = '10000000-0000-4000-8000-00000000000a'
const PROPS = { params: Promise.resolve({ id: A_ID }) }
const B_ID = '10000000-0000-4000-8000-00000000000b'
const call = (body = { profile_id: B_ID }) => POST(req(body), PROPS)

// In band: 2026-09-28 10:00Z = 11:00 Dublin. Quiet: 22:30Z = 23:30 Dublin.
const IN_BAND = Date.parse('2026-09-28T10:00:00Z')
const QUIET = Date.parse('2026-09-28T22:30:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: IN_BAND, toFake: ['Date'] })
  getCurrentUser.mockResolvedValue(MANAGER)
  readReplaceContext.mockResolvedValue(ctx({ toProfile: { id: B_ID, full_name: 'Coach B', active: true } }))
  replaceShiftAssignment.mockResolvedValue({ ok: true, closedSwapIds: [] })
  findSwapConflicts.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe('POST /replace — who may', () => {
  it('401 signed out, 403 for someone who manages nowhere, with nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    getCurrentUser.mockResolvedValue({ ...COACH, rolesByLocation: { 'loc-1': 'staff' } })
    expect((await call()).status).toBe(403)
    expect(readReplaceContext).not.toHaveBeenCalled()
  })
  it('404 for a manager of another studio (the id is not confirmed)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await call()).status).toBe(404)
    expect(replaceShiftAssignment).not.toHaveBeenCalled()
  })
  it('403 for a member who manages a DIFFERENT studio (role at the block\'s studio decides)', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    expect((await call()).status).toBe(403)
  })
  it('404 when the assignment does not exist; 500 when the read failed', async () => {
    readReplaceContext.mockResolvedValue({ ...ctx(), assignment: null, block: null })
    expect((await call()).status).toBe(404)
    readReplaceContext.mockResolvedValue({ ...ctx(), error: { message: 'down' } })
    expect((await call()).status).toBe(500)
  })
  it('400 on a body without a profile id', async () => {
    expect((await call({})).status).toBe(400)
  })
  it('404 for an id that is not a uuid, with nothing read', async () => {
    expect((await POST(req({ profile_id: B_ID }), { params: Promise.resolve({ id: 'nope' }) })).status).toBe(404)
    expect(readReplaceContext).not.toHaveBeenCalled()
  })
  it('reads the context for the path id and the body\'s coach', async () => {
    await call()
    expect(readReplaceContext).toHaveBeenCalledWith(expect.anything(), { assignmentId: A_ID, toProfileId: B_ID })
  })
})

describe('POST /replace — refusals come from the pure rule', () => {
  it('a started shift is 409 shift_started, nothing written', async () => {
    vi.setSystemTime(Date.parse('2026-09-29T05:01:00Z')) // 06:01 Dublin
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('shift_started')
    expect(replaceShiftAssignment).not.toHaveBeenCalled()
  })
  it('a coach from another studio is 400 not_at_studio', async () => {
    readReplaceContext.mockResolvedValue(ctx({ toIsMember: false, toProfile: null }))
    expect((await (await call()).json()).code).toBe('not_at_studio')
  })
  it('the write\'s own refusals map to 409', async () => {
    replaceShiftAssignment.mockResolvedValue({ code: 'changed' })
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, code: 'changed', error: 'This shift has just changed. Refresh and try again.' })
  })
})

describe('POST /replace — leave and clashes are a confirm step', () => {
  it('a conflict answers 409 swap_conflicts with the sentences, and nothing is written', async () => {
    findSwapConflicts.mockResolvedValue([{ kind: 'leave', coachId: B_ID, message: 'Coach B has approved holiday on 2026-09-29, which covers the shift on 2026-09-29.' }])
    const res = await call()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'swap_conflicts', conflicts: [expect.objectContaining({ kind: 'leave' })] })
    expect(findSwapConflicts).toHaveBeenCalledWith(expect.anything(),
      [{ role: 'taker', coachId: B_ID, block: BLOCK, leavingAssignmentId: null }], { viewerId: 'mgr-1' })
    expect(replaceShiftAssignment).not.toHaveBeenCalled()
  })
  it('confirm_conflicts skips the check', async () => {
    const res = await call({ profile_id: B_ID, confirm_conflicts: true })
    expect(res.status).toBe(200)
    expect(findSwapConflicts).not.toHaveBeenCalled()
  })
})

describe('POST /replace — the log pair and ONE notice each', () => {
  it('published, in band: two log rows via replace, then notifyRosterChanges once with both changes and the start time', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ assignment_id: 'as-1', from_profile_id: 'coach-a', profile_id: B_ID, notice: 'now', closed_swaps: 0 })
    expect(logRosterChange.mock.calls.map((c) => [c[1].coachId, c[1].action, c[1].details])).toEqual([
      ['coach-a', 'unassigned', { via: 'replace' }],
      [B_ID, 'assigned', { via: 'replace' }],
    ])
    expect(after).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges).toHaveBeenCalledWith(expect.anything(), {
      locationId: 'loc-1', actorId: 'mgr-1',
      changes: [
        { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: 'coach-a', action: 'unassigned' },
        { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: B_ID, action: 'assigned' },
      ],
    })
  })
  // Review 1 — notifyRosterChanges never throws, so a .catch on it could
  // never fire. What CAN go wrong is reported in its result: a stamp lost
  // after a delivery (the arm will tell that coach again) or a failed send.
  it('in band: a lost post-delivery stamp or a failed send is logged from after(), never thrown', async () => {
    notifyRosterChanges.mockResolvedValueOnce({ notified: 2, stampFailed: 1, failed: 0, byCoach: {} })
    expect((await call()).status).toBe(200)
    expect(logError).toHaveBeenCalledWith('shift-replace', expect.stringMatching(/told again/),
      expect.objectContaining({ assignmentId: 'as-1', stampFailed: 1, failed: 0 }))
  })
  it('in band, clean: nothing logged', async () => {
    notifyRosterChanges.mockResolvedValueOnce({ notified: 2, stampFailed: 0, failed: 0, byCoach: {} })
    await call()
    expect(logError).not.toHaveBeenCalled()
  })
  it('published, quiet hours: logged, NOT sent (the */5 arm sends from 07:00), notice morning', async () => {
    vi.setSystemTime(QUIET)
    const body = await (await call()).json()
    expect(body.data.notice).toBe('morning')
    expect(logRosterChange).toHaveBeenCalledTimes(2)
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })
  // Review 5 — out of band the row IS the held notice, so a failed insert is
  // tried once more before the loss is logged.
  it('quiet hours: a change-log insert that fails once is retried, and nothing is logged when the retry lands', async () => {
    vi.setSystemTime(QUIET)
    logRosterChange.mockResolvedValueOnce({ logged: false, reason: 'error' })
    expect((await call()).status).toBe(200)
    expect(logRosterChange).toHaveBeenCalledTimes(3) // A's twice, B's once
    expect(logRosterChange.mock.calls[1][1]).toEqual(logRosterChange.mock.calls[0][1])
    expect(logError).not.toHaveBeenCalled()
  })
  it('in band the insert is not retried: the notice does not depend on it', async () => {
    logRosterChange.mockResolvedValueOnce({ logged: false, reason: 'error' })
    await call()
    expect(logRosterChange).toHaveBeenCalledTimes(2)
  })
  it('quiet hours and a log row not written twice: that held notice is lost, so it is logged loudly', async () => {
    vi.setSystemTime(QUIET)
    logRosterChange.mockResolvedValueOnce({ logged: false, reason: 'error' }).mockResolvedValueOnce({ logged: false, reason: 'error' })
    const res = await call()
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledWith('shift-replace', expect.stringMatching(/will not be sent/),
      expect.objectContaining({ coachId: 'coach-a', action: 'unassigned', reason: 'error' }))
  })
  it('a draft: nothing logged, nothing sent, notice none', async () => {
    readReplaceContext.mockResolvedValue(ctx({ block: { ...BLOCK, rosters: { status: 'draft' } }, toProfile: { id: B_ID, active: true } }))
    const body = await (await call()).json()
    expect(body.data.notice).toBe('none')
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })
})
