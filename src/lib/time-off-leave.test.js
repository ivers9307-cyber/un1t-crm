// LEAVE.2 — pure rules behind the time-off routes.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
const { logWarn } = await import('@/lib/log')
import {
  leaveScopeOrFilter, canDecideTimeOff, timeOffApproverIdsFrom, entitlementDays,
  clashWindow, bucketClashCounts, getHolidayAllowance, ensureHolidayAllowanceRow,
  getNonWorkingDates, findLeaveClashes, decidingLocationIds, countLeaveClashes,
  ownShiftPreviewRow, findOwnPublishedShifts, chargeableLeaveSegments, isRealIsoDate,
  getOrgAdminLocationIdsByProfile, getProfileLocationIds,
} from './time-off-leave.js'
import { fakeDb, queriesOf, resolveLocations, scopedAssignments, locationScopeOf } from './time-off.test-helpers.js'

describe('leaveScopeOrFilter', () => {
  it('filed at the studio OR taken by one of its members, deduped', () => {
    expect(leaveScopeOrFilter(['l1'], ['p1', 'p2', 'p1'])).toBe('location_id.in.(l1),profile_id.in.(p1,p2)')
  })
  it('no members → the filed-at half alone', () => {
    expect(leaveScopeOrFilter(['l1'], [])).toBe('location_id.in.(l1)')
  })
})

describe('canDecideTimeOff', () => {
  const hc = (locs, perms = {}) => ({
    id: 'u', role: 'head_coach', profileRole: 'staff',
    locations: locs.map((id) => ({ id, role: 'head_coach', features: {} })),
    assignmentsByLocation: Object.fromEntries(locs.map((id) => [id, { role: 'head_coach', permissions: perms }])),
  })
  it('a head coach holds time-off approval by default at their studio', () => {
    expect(canDecideTimeOff(hc(['l1']), 'l1')).toBe(true)
  })
  it('counts the requester\'s other studios, never a studio the caller is not at', () => {
    expect(canDecideTimeOff(hc(['l2']), 'l1', ['l1', 'l2'])).toBe(true)
    expect(canDecideTimeOff(hc(['l2']), 'l1', ['l1'])).toBe(false)
  })
  it('a per-user override that removes the grant is honoured', () => {
    expect(canDecideTimeOff(hc(['l1'], { approvals_time_off: false }), 'l1')).toBe(false)
  })
  it('staff cannot; master always can', () => {
    const staff = { id: 's', profileRole: 'staff', locations: [{ id: 'l1', role: 'staff' }], assignmentsByLocation: { l1: { role: 'staff', permissions: {} } } }
    expect(canDecideTimeOff(staff, 'l1')).toBe(false)
    expect(canDecideTimeOff({ profileRole: 'master', role: 'master' }, 'l1')).toBe(true)
  })
})

describe('timeOffApproverIdsFrom', () => {
  const link = (profile_id, role, location_id = 'l1', over = {}) => ({
    profile_id, location_id, role, permissions: {}, profiles: { active: true, role: 'staff', employment_type: 'fte' }, ...over,
  })
  it('owners, managers AND head coaches; not staff, not inactive', () => {
    const ids = timeOffApproverIdsFrom({
      links: [link('o', 'owner'), link('m', 'manager'), link('h', 'head_coach'), link('s', 'staff'),
        link('x', 'manager', 'l1', { profiles: { active: false, role: 'staff' } })],
      templates: [], featuresByLocation: {},
    })
    expect(ids.sort()).toEqual(['h', 'm', 'o'])
  })
  it('honours a role template that removes it, and a per-user grant that adds it', () => {
    const ids = timeOffApproverIdsFrom({
      links: [link('h', 'head_coach'), link('s', 'staff', 'l1', { permissions: { approvals_time_off: true } })],
      templates: [{ location_id: 'l1', role: 'head_coach', employment_type: 'all', permissions: { approvals_time_off: false } }],
      featuresByLocation: {},
    })
    expect(ids).toEqual(['s'])
  })
  it('a master linked anywhere is always included', () => {
    expect(timeOffApproverIdsFrom({ links: [link('boss', 'staff', 'l1', { profiles: { active: true, role: 'master' } })], templates: [], featuresByLocation: {} })).toEqual(['boss'])
  })
})

describe('entitlement + allowance', () => {
  it('entitlementDays: null/blank/garbage → 20; a real value is kept, 0 included', () => {
    expect(entitlementDays(null)).toBe(20)
    expect(entitlementDays('')).toBe(20)
    expect(entitlementDays('abc')).toBe(20)
    expect(entitlementDays('15.0')).toBe(15)
    expect(entitlementDays(0)).toBe(0)
  })

  it('getHolidayAllowance: no row → the entitlement, unstored', async () => {
    const db = fakeDb((q) => (q.table === 'profile_compensation' ? { data: { annual_leave_entitlement: 22 }, error: null } : { data: null, error: null }))
    const { allowance } = await getHolidayAllowance(db, 'p', 2026)
    expect(allowance).toEqual({ exists: false, total_days: 22, used_days: 0, carried_over: 0 })
  })

  it('getHolidayAllowance: a read error is returned, never read as "no row"', async () => {
    const db = fakeDb(() => ({ data: null, error: { message: 'down' } }))
    const { allowance, error } = await getHolidayAllowance(db, 'p', 2026)
    expect(allowance).toBeNull()
    expect(error.message).toBe('down')
  })

  it('ensureHolidayAllowanceRow inserts once from the entitlement, tolerates a race, never touches a row', async () => {
    let db = fakeDb((q) => (q.table === 'profile_compensation' ? { data: { annual_leave_entitlement: 18 }, error: null } : { data: null, error: null }))
    expect((await ensureHolidayAllowanceRow(db, 'p', 2026)).error).toBeNull()
    expect(queriesOf(db, 'staff_allowances', 'insert')[0].payload).toEqual({ profile_id: 'p', year: 2026, total_days: 18, used_days: 0, carried_over: 0 })

    db = fakeDb((q) => (q.action === 'insert' ? { error: { code: '23505', message: 'dup' } } : { data: null, error: null }))
    expect((await ensureHolidayAllowanceRow(db, 'p', 2026)).error).toBeNull()

    db = fakeDb((q) => (q.table === 'staff_allowances' && q.action === 'select' ? { data: { total_days: 20, used_days: 5, carried_over: 0 }, error: null } : { data: null, error: null }))
    await ensureHolidayAllowanceRow(db, 'p', 2026)
    expect(db.queries.filter((q) => q.action !== 'select')).toHaveLength(0)
  })
})

describe('clashes', () => {
  it('clashWindow starts at today and is empty once the leave is over', () => {
    expect(clashWindow({ start_date: '2026-06-01', end_date: '2026-06-05' }, '2026-05-01')).toEqual({ lo: '2026-06-01', hi: '2026-06-05' })
    expect(clashWindow({ start_date: '2026-06-01', end_date: '2026-06-05' }, '2026-06-03')).toEqual({ lo: '2026-06-03', hi: '2026-06-05' })
    expect(clashWindow({ start_date: '2026-06-01', end_date: '2026-06-05' }, '2026-06-06')).toBeNull()
  })

  it('bucketClashCounts: live shifts of that person inside that window; closed requests are not counted', () => {
    const requests = [
      { id: 'r1', profile_id: 'p1', status: 'approved', start_date: '2026-06-01', end_date: '2026-06-03' },
      { id: 'r2', profile_id: 'p2', status: 'pending', start_date: '2026-06-01', end_date: '2026-06-01' },
      { id: 'r3', profile_id: 'p1', status: 'rejected', start_date: '2026-06-01', end_date: '2026-06-03' },
    ]
    const shifts = [
      { profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-06-02' } },
      { profile_id: 'p1', status: 'cancelled', shift_blocks: { block_date: '2026-06-02' } },
      { profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-06-04' } },
      { profile_id: 'p2', status: 'confirmed', shift_blocks: { block_date: '2026-06-01' } },
    ]
    expect(bucketClashCounts(requests, shifts, '2026-05-01')).toEqual({ r1: 1, r2: 1 })
  })

  it('bucketClashCounts with a per-request scope: a shift outside that request\'s studios is not counted; an unlisted request counts 0', () => {
    const requests = [
      { id: 'r1', profile_id: 'p1', status: 'pending', start_date: '2026-06-01', end_date: '2026-06-03' },
      { id: 'r2', profile_id: 'p1', status: 'pending', start_date: '2026-06-01', end_date: '2026-06-03' },
    ]
    const shifts = [
      { profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-06-02', location_id: 'l1' } },
      { profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-06-02', location_id: 'l9' } },
    ]
    expect(bucketClashCounts(requests, shifts, '2026-05-01', new Map([['r1', new Set(['l1'])]]))).toEqual({ r1: 1, r2: 0 })
  })
})

// ORGSCOPE.1 — nothing keeps a person inside one organisation, and a clash
// row carries the other shift's name, times and studio. "Any studio" must mean
// "any studio of the organisation the decider is acting in".
describe('findLeaveClashes — organisation boundary', () => {
  // loc-a1 + loc-a2 share org-a; loc-b1 is another organisation's studio.
  const ORGS = { 'loc-a1': 'org-a', 'loc-a2': 'org-a', 'loc-b1': 'org-b' }
  const shift = (id, location_id, name) => ({
    id, profile_id: 'p1', block_id: `b-${id}`, status: 'scheduled',
    shift_blocks: {
      id: `b-${id}`, block_date: '2026-06-02', start_time: '09:00', end_time: '10:00', location_id,
      rosters: { status: 'published' }, shift_templates: { name }, locations: { name: `Studio ${location_id}` },
    },
  })
  const SHIFTS = [shift('s1', 'loc-a1', 'Morning'), shift('s2', 'loc-a2', 'Lunch'), shift('s3', 'loc-b1', 'Other org shift')]
  const REQUEST = { id: 'r1', profile_id: 'p1', location_id: 'loc-a1', start_date: '2026-06-01', end_date: '2026-06-03' }

  // The fakes honour the location filter the way PostgREST would: no filter =
  // every row, which is exactly the leak.
  function db({ locationsErr = null } = {}) {
    return fakeDb((q) => {
      if (q.table === 'locations') return locationsErr ? { data: null, error: locationsErr } : resolveLocations(q, ORGS)
      if (q.table === 'shift_assignments') return scopedAssignments(q, SHIFTS)
      throw new Error(`unexpected table ${q.table}`)
    })
  }
  const scopeOf = (d) => locationScopeOf(queriesOf(d, 'shift_assignments')[0])

  beforeEach(() => logWarn.mockClear())

  it('a shift at a studio in a DIFFERENT organisation is not a clash', async () => {
    const { clashes, error } = await findLeaveClashes(db(), REQUEST, '2026-05-01')
    expect(error).toBeNull()
    expect(clashes.map((c) => c.id)).toEqual(['s1', 's2'])
    expect(clashes.map((c) => c.template_name)).not.toContain('Other org shift')
  })

  it('a studio with no siblings reads that studio only: no cross-studio read at all', async () => {
    const d = db()
    const { clashes } = await findLeaveClashes(d, { ...REQUEST, location_id: 'loc-b1' }, '2026-05-01')
    expect(scopeOf(d)).toEqual(['loc-b1'])
    expect(queriesOf(d, 'shift_assignments')).toHaveLength(1)
    expect(clashes.map((c) => c.id)).toEqual(['s3'])
  })

  it('scopes from the studios the DECIDER acts at, not from where the leave was filed', async () => {
    // Filed at org-a, decided by someone entitled only at the person's org-b
    // studio: they see org-b's shift and none of org-a's.
    const { clashes } = await findLeaveClashes(db(), REQUEST, '2026-05-01', { scopeLocationIds: ['loc-b1'] })
    expect(clashes.map((c) => c.id)).toEqual(['s3'])
  })

  it('several deciding studios widen the scope to each of their organisations', async () => {
    const { clashes } = await findLeaveClashes(db(), REQUEST, '2026-05-01', { scopeLocationIds: ['loc-a2', 'loc-b1'] })
    expect(clashes.map((c) => c.id).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('fails soft: unreadable siblings narrow the check to the deciding studio, never widen it and never error', async () => {
    const d = db({ locationsErr: { message: 'down' } })
    const { clashes, error } = await findLeaveClashes(d, REQUEST, '2026-05-01')
    expect(error).toBeNull()
    expect(scopeOf(d)).toEqual(['loc-a1'])
    expect(clashes.map((c) => c.id)).toEqual(['s1'])
    expect(logWarn).toHaveBeenCalled()
  })

  it('a decider with NO deciding studio sees nothing: an empty scope never falls back to the filed-at studio', async () => {
    const d = db()
    const { clashes } = await findLeaveClashes(d, REQUEST, '2026-05-01', { scopeLocationIds: [] })
    expect(clashes).toEqual([])
    expect(queriesOf(d, 'shift_assignments')).toHaveLength(0)
  })

  it('no studio to scope from: no assignments are read', async () => {
    const d = db()
    const { clashes, error } = await findLeaveClashes(d, { ...REQUEST, location_id: null }, '2026-05-01')
    expect(clashes).toEqual([])
    expect(error).toBeNull()
    expect(queriesOf(d, 'shift_assignments')).toHaveLength(0)
    expect(logWarn).toHaveBeenCalled()
  })
})

// ORGSCOPE.2 — the clash COUNT (the Time Off list badge and the approvals
// queue warning) obeys the same boundary as the clash LIST the approver gets
// from findLeaveClashes, request by request, so the two can never disagree.
describe('countLeaveClashes — organisation boundary', () => {
  // org-a: loc-a1 + loc-a2. org-b: loc-b1 + loc-b2. org-c: loc-c1 alone.
  const ORGS = { 'loc-a1': 'org-a', 'loc-a2': 'org-a', 'loc-b1': 'org-b', 'loc-b2': 'org-b', 'loc-c1': 'org-c' }
  const shift = (id, profile_id, location_id, block_date = '2026-06-02') => ({
    id, profile_id, status: 'scheduled', shift_blocks: { block_date, location_id },
  })
  const request = (id, profile_id, location_id, over = {}) => ({
    id, profile_id, location_id, status: 'pending', start_date: '2026-06-01', end_date: '2026-06-03', ...over,
  })
  const approver = (locs, id = 'u') => ({
    id, role: 'head_coach', profileRole: 'staff',
    locations: locs.map((l) => ({ id: l, role: 'head_coach', features: {} })),
    assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role: 'head_coach', permissions: {} }])),
  })

  // The fakes honour the filters: an OPEN shift read returns every shift.
  function db({ memberships, shifts, locationsErr = null, membershipsErr = null }) {
    return fakeDb((q) => {
      if (q.table === 'locations') return locationsErr ? { data: null, error: locationsErr } : resolveLocations(q, ORGS)
      if (q.table === 'profile_locations') {
        if (membershipsErr) return { data: null, error: membershipsErr }
        const ids = q.calls.find(([op, col]) => op === 'in' && col === 'profile_id')?.[2] || []
        return { data: ids.flatMap((pid) => (memberships[pid] || []).map((location_id) => ({ profile_id: pid, location_id }))), error: null }
      }
      if (q.table === 'shift_assignments') {
        const who = q.calls.find(([op, col]) => op === 'in' && col === 'profile_id')?.[2] || []
        return scopedAssignments(q, shifts.filter((s) => who.includes(s.profile_id)))
      }
      throw new Error(`unexpected table ${q.table}`)
    })
  }
  const shiftReads = (d) => queriesOf(d, 'shift_assignments')
  const scopeOf = (d, i = 0) => locationScopeOf(shiftReads(d)[i])

  beforeEach(() => logWarn.mockClear())

  it('a shift at a studio in a DIFFERENT organisation is not counted', async () => {
    const d = db({
      memberships: { p1: ['loc-a1', 'loc-b1'] },
      shifts: [shift('s1', 'p1', 'loc-a1'), shift('s2', 'p1', 'loc-a2'), shift('s3', 'p1', 'loc-b1')],
    })
    const { counts, error } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1')], '2026-05-01', { user: approver(['loc-a1']) })
    expect(error).toBeNull()
    expect(counts).toEqual({ r1: 2 })
    expect(scopeOf(d).sort()).toEqual(['loc-a1', 'loc-a2'])
  })

  it('a caller whose studio has no siblings reads that studio only: no cross-studio read', async () => {
    const d = db({
      memberships: { p1: ['loc-c1', 'loc-a1'] },
      shifts: [shift('s1', 'p1', 'loc-c1'), shift('s2', 'p1', 'loc-a1')],
    })
    const { counts } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-c1')], '2026-05-01', { user: approver(['loc-c1']) })
    expect(shiftReads(d)).toHaveLength(1)
    expect(scopeOf(d)).toEqual(['loc-c1'])
    expect(counts).toEqual({ r1: 1 })
  })

  it('fails soft: unreadable siblings narrow the count to the deciding studio, never widen it and never error', async () => {
    const d = db({
      memberships: { p1: ['loc-a1', 'loc-a2', 'loc-b1'] },
      shifts: [shift('s1', 'p1', 'loc-a1'), shift('s2', 'p1', 'loc-a2'), shift('s3', 'p1', 'loc-b1')],
      locationsErr: { message: 'down' },
    })
    const { counts, error } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1')], '2026-05-01', { user: approver(['loc-a1']) })
    expect(error).toBeNull()
    expect(scopeOf(d)).toEqual(['loc-a1'])
    expect(counts).toEqual({ r1: 1 })
    expect(logWarn).toHaveBeenCalled()
  })

  it('fails soft: unreadable memberships narrow each request to the studio it was filed at', async () => {
    // The caller approves at loc-b1 too, and would reach org-b through the
    // person's membership there; without the membership list only the filed-at
    // studio is a candidate.
    const d = db({
      memberships: { p1: ['loc-a1', 'loc-b1'] },
      shifts: [shift('s1', 'p1', 'loc-a1'), shift('s3', 'p1', 'loc-b1')],
      membershipsErr: { message: 'down' },
    })
    const { counts, error } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1')], '2026-05-01', { user: approver(['loc-a1', 'loc-b1']) })
    expect(error).toBeNull()
    expect(scopeOf(d).sort()).toEqual(['loc-a1', 'loc-a2'])
    expect(counts).toEqual({ r1: 1 })
    expect(logWarn).toHaveBeenCalled()
  })

  it('scopes PER REQUEST: one batched read, but a studio that only another request reaches is not counted', async () => {
    // The caller approves at loc-a1 and loc-b1. p1 is at loc-a1 only; p2 is at
    // loc-b1 only. The read covers both organisations, the counts do not mix.
    const d = db({
      memberships: { p1: ['loc-a1'], p2: ['loc-b1'] },
      shifts: [shift('s1', 'p1', 'loc-a1'), shift('s2', 'p1', 'loc-b2'), shift('s3', 'p2', 'loc-b1'), shift('s4', 'p2', 'loc-a2')],
    })
    const { counts } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1'), request('r2', 'p2', 'loc-b1')], '2026-05-01', { user: approver(['loc-a1', 'loc-b1']) })
    expect(shiftReads(d)).toHaveLength(1)
    expect(counts).toEqual({ r1: 1, r2: 1 })
  })

  it('the badge equals the list: same number findLeaveClashes shows this approver for this request', async () => {
    const fixture = {
      memberships: { p1: ['loc-a1', 'loc-b2'] },
      shifts: [shift('s1', 'p1', 'loc-a1'), shift('s2', 'p1', 'loc-a2'), shift('s3', 'p1', 'loc-b2'), shift('s4', 'p1', 'loc-b1')],
    }
    const user = approver(['loc-a1', 'loc-b1'])
    const r = request('r1', 'p1', 'loc-a1')
    const { counts } = await countLeaveClashes(db(fixture), [r], '2026-05-01', { user })
    const { clashes } = await findLeaveClashes(db(fixture), r, '2026-05-01', {
      scopeLocationIds: decidingLocationIds(user, r.location_id, fixture.memberships.p1),
    })
    expect(counts.r1).toBe(clashes.length)
    expect(counts.r1).toBe(2)
  })

  it('a caller who decides nowhere for a request reads no shifts for it and counts 0', async () => {
    const d = db({ memberships: { p1: ['loc-a1'] }, shifts: [shift('s1', 'p1', 'loc-a1')] })
    const { counts, error } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1')], '2026-05-01', { user: approver(['loc-c1']) })
    expect(error).toBeNull()
    expect(counts).toEqual({ r1: 0 })
    expect(shiftReads(d)).toHaveLength(0)
  })

  it('no caller at all: nothing is read', async () => {
    const d = db({ memberships: { p1: ['loc-a1'] }, shifts: [shift('s1', 'p1', 'loc-a1')] })
    const { counts } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1')], '2026-05-01')
    expect(counts).toEqual({ r1: 0 })
    expect(shiftReads(d)).toHaveLength(0)
  })

  it('your OWN request counts your own shifts at every studio: they are yours to see', async () => {
    const d = db({
      memberships: { me: ['loc-a1', 'loc-b1'] },
      shifts: [shift('s1', 'me', 'loc-a1'), shift('s2', 'me', 'loc-b1')],
    })
    const staff = { id: 'me', profileRole: 'staff', locations: [{ id: 'loc-a1', role: 'staff' }], assignmentsByLocation: { 'loc-a1': { role: 'staff', permissions: {} } } }
    const { counts } = await countLeaveClashes(d, [request('r1', 'me', 'loc-a1')], '2026-05-01', { user: staff })
    expect(counts).toEqual({ r1: 2 })
  })

  it('an own request never widens the read for a colleague\'s request in the same list', async () => {
    const d = db({
      memberships: { me: ['loc-a1', 'loc-b1'], p1: ['loc-a1', 'loc-b1'] },
      shifts: [shift('s1', 'me', 'loc-b1'), shift('s2', 'p1', 'loc-a1'), shift('s3', 'p1', 'loc-b1')],
    })
    const { counts } = await countLeaveClashes(d, [request('mine', 'me', 'loc-a1'), request('r1', 'p1', 'loc-a1')], '2026-05-01', { user: approver(['loc-a1'], 'me') })
    expect(counts).toEqual({ mine: 1, r1: 1 })
    const colleagueRead = shiftReads(d).find((q) => q.calls.some(([op, col, v]) => op === 'in' && col === 'profile_id' && v.includes('p1')))
    expect(locationScopeOf(colleagueRead).sort()).toEqual(['loc-a1', 'loc-a2'])
  })

  it('master: every organisation the PERSON is in, which is what the approve list shows a master', async () => {
    const d = db({
      memberships: { p1: ['loc-a1', 'loc-b1'] },
      shifts: [shift('s1', 'p1', 'loc-a1'), shift('s2', 'p1', 'loc-b2'), shift('s3', 'p1', 'loc-c1')],
    })
    const { counts } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1')], '2026-05-01', { user: { id: 'boss', profileRole: 'master', role: 'master' } })
    expect(scopeOf(d).sort()).toEqual(['loc-a1', 'loc-a2', 'loc-b1', 'loc-b2'])
    expect(counts).toEqual({ r1: 2 })
  })

  it('a failed shift read is returned as an error with no counts, as before', async () => {
    const d = fakeDb((q) => {
      if (q.table === 'locations') return resolveLocations(q, ORGS)
      if (q.table === 'profile_locations') return { data: [{ profile_id: 'p1', location_id: 'loc-a1' }], error: null }
      return { data: null, error: { message: 'boom' } }
    })
    const { counts, error } = await countLeaveClashes(d, [request('r1', 'p1', 'loc-a1')], '2026-05-01', { user: approver(['loc-a1']) })
    expect(counts).toEqual({})
    expect(error.message).toBe('boom')
  })
})

describe('decidingLocationIds', () => {
  const hc = (locs) => ({
    id: 'u', role: 'head_coach', profileRole: 'staff',
    locations: locs.map((id) => ({ id, role: 'head_coach', features: {} })),
    assignmentsByLocation: Object.fromEntries(locs.map((id) => [id, { role: 'head_coach', permissions: {} }])),
  })
  it('only the candidate studios where the caller holds time-off approval', () => {
    expect(decidingLocationIds(hc(['l2', 'l9']), 'l1', ['l1', 'l2'])).toEqual(['l2'])
    expect(decidingLocationIds(hc(['l9']), 'l1', ['l1', 'l2'])).toEqual([])
  })
  it('master: every candidate; nobody: none', () => {
    expect(decidingLocationIds({ profileRole: 'master' }, 'l1', ['l1', 'l2'])).toEqual(['l1', 'l2'])
    expect(decidingLocationIds(null, 'l1', ['l2'])).toEqual([])
  })
})

// HOLIDAYLEAVE.1 — which dates cost no holiday allowance at this studio.
describe('getNonWorkingDates', () => {
  const dbWith = ({ country = 'IE', custom = [], locError = null, customError = null } = {}) => fakeDb((q) => {
    if (q.table === 'locations') return { data: locError ? null : { country }, error: locError }
    if (q.table === 'location_holidays') return { data: customError ? null : custom, error: customError }
    throw new Error(q.table)
  })

  it('national bank holidays for the studio\'s country plus its own closures, inside the range', async () => {
    const db = dbWith({ custom: [{ date: '2026-06-10', name: 'Studio closed' }] })
    const { dates, error } = await getNonWorkingDates(db, 'loc-1', '2026-06-01', '2026-06-14')
    expect(error).toBeNull()
    expect([...dates].sort()).toEqual(['2026-06-01', '2026-06-10'])
  })

  it('scopes BOTH reads to the studio, and the closures read to the range', async () => {
    const db = dbWith()
    await getNonWorkingDates(db, 'loc-1', '2026-06-01', '2026-06-14')
    expect(queriesOf(db, 'locations')[0].eq).toEqual({ id: 'loc-1' })
    const closures = queriesOf(db, 'location_holidays')[0]
    expect(closures.eq).toEqual({ location_id: 'loc-1' })
    expect(closures.columns).toBe('date') // the only column the day count needs
    expect(closures.calls).toContainEqual(['gte', 'date', '2026-06-01'])
    expect(closures.calls).toContainEqual(['lte', 'date', '2026-06-14'])
  })

  it('a studio in another country gets that country\'s list', async () => {
    const { dates } = await getNonWorkingDates(dbWith({ country: 'GB' }), 'loc-1', '2026-05-25', '2026-06-07')
    expect([...dates]).toEqual(['2026-05-25'])
  })

  it('a studio with no country on file is treated as Ireland (the GET holidays route does the same)', async () => {
    const { dates } = await getNonWorkingDates(dbWith({ country: null }), 'loc-1', '2026-06-01', '2026-06-07')
    expect([...dates]).toEqual(['2026-06-01'])
  })

  // The static lists stop (2030 today) and do not know every country. There
  // "no national holidays" means "no list": the request is still served, with
  // the studio's own closures, but it must leave a trace, because it is the old
  // over-charge again.
  describe('a year or country with no national list', () => {
    beforeEach(() => logWarn.mockClear())

    it('is silent when the list covers the range', async () => {
      await getNonWorkingDates(dbWith(), 'loc-1', '2026-06-01', '2026-06-07')
      expect(logWarn).not.toHaveBeenCalled()
    })

    it('warns ONCE per call, naming the country and every uncovered year, and still returns the closures', async () => {
      const db = dbWith({ custom: [{ date: '2099-12-30', name: 'Studio closed' }] })
      const { dates, error } = await getNonWorkingDates(db, 'loc-1', '2099-12-20', '2100-01-10')
      expect(error).toBeNull()
      expect([...dates]).toEqual(['2099-12-30'])
      expect(logWarn).toHaveBeenCalledTimes(1)
      expect(logWarn).toHaveBeenCalledWith('time-off', expect.stringMatching(/no national bank-holiday list/i),
        { locationId: 'loc-1', country: 'IE', years: [2099, 2100] })
    })

    it('warns for a country there is no list for at all', async () => {
      await getNonWorkingDates(dbWith({ country: 'ZZ' }), 'loc-1', '2026-06-01', '2026-06-07')
      expect(logWarn).toHaveBeenCalledTimes(1)
      expect(logWarn.mock.calls[0][2]).toEqual({ locationId: 'loc-1', country: 'ZZ', years: [2026] })
    })

    // LEAVEPHONE.1 — the leave form's preview asks on every tap of the
    // calendar; it is not a request, so it must not write the request's warning.
    it('quiet: the same dates, and NO warning', async () => {
      const db = dbWith({ custom: [{ date: '2099-12-30', name: 'Studio closed' }] })
      const { dates, error } = await getNonWorkingDates(db, 'loc-1', '2099-12-20', '2100-01-10', { quiet: true })
      expect(error).toBeNull()
      expect([...dates]).toEqual(['2099-12-30'])
      expect(logWarn).not.toHaveBeenCalled()
    })

    it('does not warn when the read itself failed: that is already an error', async () => {
      await getNonWorkingDates(dbWith({ country: 'ZZ', customError: { message: 'closures boom' } }), 'loc-1', '2026-06-01', '2026-06-07')
      expect(logWarn).not.toHaveBeenCalled()
    })
  })

  it('an unreadable studio or closures list is an ERROR, never "no holidays"', async () => {
    expect(await getNonWorkingDates(dbWith({ locError: { message: 'loc boom' } }), 'loc-1', '2026-06-01', '2026-06-07'))
      .toEqual({ dates: null, error: { message: 'loc boom' } })
    expect(await getNonWorkingDates(dbWith({ customError: { message: 'closures boom' } }), 'loc-1', '2026-06-01', '2026-06-07'))
      .toEqual({ dates: null, error: { message: 'closures boom' } })
  })
})

describe('own published shifts — the coach leave preview (LEAVEPHONE.1)', () => {
  const asg = (id, date, rosterStatus, extra = {}) => ({
    id, profile_id: 'me', status: 'scheduled', start_time_override: null, end_time_override: null,
    shift_blocks: {
      id: `b-${id}`, block_date: date, start_time: '06:00:00', end_time: '09:00:00', location_id: 'loc-1',
      rosters: rosterStatus ? { status: rosterStatus } : null,
      shift_templates: { name: 'Morning', start_time: '06:00:00', end_time: '07:00:00' },
      locations: { name: 'Studio One' },
    },
    ...extra,
  })

  it('ownShiftPreviewRow resolves times override → block → template and carries nothing else', () => {
    expect(ownShiftPreviewRow(asg('a', '2026-10-05', 'published'))).toEqual({
      id: 'a', block_date: '2026-10-05', start_time: '06:00:00', end_time: '09:00:00',
      template_name: 'Morning', location_name: 'Studio One',
    })
    expect(ownShiftPreviewRow(asg('a', '2026-10-05', 'published', { start_time_override: '07:30:00' })).start_time).toBe('07:30:00')
    const templateOnly = asg('a', '2026-10-05', 'published')
    templateOnly.shift_blocks.start_time = null
    templateOnly.shift_blocks.end_time = null
    expect(ownShiftPreviewRow(templateOnly)).toMatchObject({ start_time: '06:00:00', end_time: '07:00:00' })
  })

  it('the row is an allow-list: notes, pay, status and other ids on the source never reach it', () => {
    const noisy = asg('a', '2026-10-05', 'published', { notes: 'private', partial_reason: 'x', assigned_by: 'boss' })
    noisy.shift_blocks.notes = 'block note'
    noisy.shift_blocks.shift_templates.hourly_rate = 25
    noisy.shift_blocks.shift_templates.capacity = 3
    expect(Object.keys(ownShiftPreviewRow(noisy)).sort()).toEqual(
      ['block_date', 'end_time', 'id', 'location_name', 'start_time', 'template_name'],
    )
  })

  it('returns published, live, in-window shifts of THAT profile only, sorted by date then time', async () => {
    const db = fakeDb((q) => {
      if (q.table !== 'shift_assignments') throw new Error(q.table)
      return { data: [
        asg('late', '2026-10-06', 'published', { start_time_override: '17:00:00' }),
        asg('early', '2026-10-06', 'published'),
        asg('taken', '2026-10-07', 'published', { status: 'swapped' }),
        asg('draft', '2026-10-06', 'draft'),
        asg('noroster', '2026-10-06', null),
        asg('dropped', '2026-10-06', 'published', { status: 'cancelled' }),
        asg('other', '2026-10-06', 'published', { profile_id: 'someone-else' }),
      ], error: null }
    })
    const { shifts, error } = await findOwnPublishedShifts(db, 'me', '2026-10-05', '2026-10-09', '2026-09-19')
    expect(error).toBeNull()
    // `swapped` is a LIVE shift (owned by the taker); only `cancelled` is dead.
    expect(shifts.map((s) => s.id)).toEqual(['early', 'late', 'taken'])
    // The read itself is scoped to the one profile and the requested window.
    const q = queriesOf(db, 'shift_assignments')[0]
    expect(q.calls).toContainEqual(['in', 'profile_id', ['me']])
    expect(q.calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-10-05'])
    expect(q.calls).toContainEqual(['lte', 'shift_blocks.block_date', '2026-10-09'])
  })

  it('starts at today (past shifts are history) and makes NO read for a range wholly in the past', async () => {
    const db = fakeDb(() => ({ data: [], error: null }))
    await findOwnPublishedShifts(db, 'me', '2026-09-01', '2026-09-30', '2026-09-19')
    expect(queriesOf(db, 'shift_assignments')[0].calls).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-19'])

    const past = fakeDb(() => { throw new Error('must not query') })
    expect(await findOwnPublishedShifts(past, 'me', '2026-08-01', '2026-08-02', '2026-09-19')).toEqual({ shifts: [], error: null })
  })

  it('no profile id is no read and no rows — never an unscoped roster read', async () => {
    const db = fakeDb(() => { throw new Error('must not query') })
    expect(await findOwnPublishedShifts(db, null, '2026-10-05', '2026-10-09', '2026-09-19')).toEqual({ shifts: [], error: null })
  })

  it('a failed read is an error, never an empty list that reads as "no clashes"', async () => {
    const db = fakeDb(() => ({ data: null, error: { message: 'boom' } }))
    const res = await findOwnPublishedShifts(db, 'me', '2026-10-05', '2026-10-09', '2026-09-19')
    expect(res.shifts).toEqual([])
    expect(res.error).toEqual({ message: 'boom' })
  })
})

describe('chargeableLeaveSegments — the one day count (LEAVEPHONE.1)', () => {
  // Mon 1 Jun 2026 is the Irish June Public Holiday (src/lib/bank-holidays.js).
  function holidayDb({ country = 'IE', closures = [], locError = null, closuresError = null } = {}) {
    return fakeDb((q) => {
      if (q.table === 'locations') return { data: locError ? null : { country }, error: locError }
      if (q.table === 'location_holidays') return { data: closuresError ? null : closures, error: closuresError }
      throw new Error(`unexpected read of ${q.table}`)
    })
  }

  it('holiday: Mon-Fri minus the bank holiday minus the studio\'s own closure', async () => {
    const db = holidayDb({ closures: [{ date: '2026-06-03', name: 'Studio closed' }] })
    const res = await chargeableLeaveSegments(db, { type: 'holiday', locationId: 'loc-1', startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(res).toEqual({ segments: [{ s: '2026-06-01', e: '2026-06-07', days: 3 }], total: 3, error: null })
    expect(queriesOf(db, 'location_holidays')[0].eq).toEqual({ location_id: 'loc-1' })
  })

  it('one segment per year, each counted on its own', async () => {
    const res = await chargeableLeaveSegments(holidayDb(), { type: 'holiday', locationId: 'loc-1', startIso: '2026-12-30', endIso: '2027-01-04' })
    // 30, 31 Dec are working days; Fri 1 Jan 2027 is New Year's Day; Mon 4 Jan works.
    expect(res.segments).toEqual([{ s: '2026-12-30', e: '2026-12-31', days: 2 }, { s: '2027-01-01', e: '2027-01-04', days: 1 }])
    expect(res.total).toBe(3)
  })

  it('other leave types count calendar days and read NOTHING', async () => {
    const db = fakeDb(() => { throw new Error('must not query') })
    const res = await chargeableLeaveSegments(db, { type: 'sick', locationId: 'loc-1', startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(res).toMatchObject({ total: 7, error: null })
  })

  // HOLIDAYLEAVE.1 (as merged) — the POST refuses a request with no studio
  // BEFORE any read, so there is no "count Mon-Fri blind" fallback to mirror.
  it('holiday with no studio to ask is an error and reads NOTHING — never counted blind', async () => {
    const db = fakeDb(() => { throw new Error('must not query') })
    const res = await chargeableLeaveSegments(db, { type: 'holiday', locationId: null, startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(res.segments).toEqual([])
    expect(res.total).toBe(0)
    expect(res.error?.message).toMatch(/studio/i)
  })

  it('fails CLOSED — an unreadable list is an error, never "no bank holidays"', async () => {
    const res = await chargeableLeaveSegments(holidayDb({ closuresError: { message: 'boom' } }), { type: 'holiday', locationId: 'loc-1', startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(res).toEqual({ segments: [], total: 0, error: { message: 'boom' } })
    const loc = await chargeableLeaveSegments(holidayDb({ locError: { message: 'down' } }), { type: 'holiday', locationId: 'loc-1', startIso: '2026-06-01', endIso: '2026-06-07' })
    expect(loc).toEqual({ segments: [], total: 0, error: { message: 'down' } })
  })
})

describe('chargeableLeaveSegments — who writes the no-holiday-list warning (LEAVEPHONE.1)', () => {
  const db = () => fakeDb((q) => {
    if (q.table === 'locations') return { data: { country: 'IE' }, error: null }
    if (q.table === 'location_holidays') return { data: [], error: null }
    throw new Error(q.table)
  })
  const args = { type: 'holiday', locationId: 'loc-1', startIso: '2099-12-20', endIso: '2100-01-10' }
  beforeEach(() => logWarn.mockClear())

  it('the default (the POST) warns exactly ONCE per call, however many year segments', async () => {
    const res = await chargeableLeaveSegments(db(), args)
    expect(res.segments).toHaveLength(2)
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('quiet (the preview) counts the SAME days and writes nothing', async () => {
    const loud = await chargeableLeaveSegments(db(), args)
    logWarn.mockClear()
    const quiet = await chargeableLeaveSegments(db(), { ...args, quiet: true })
    expect(quiet).toEqual(loud)
    expect(logWarn).not.toHaveBeenCalled()
  })
})

describe('isRealIsoDate (LEAVEPHONE.1)', () => {
  it('accepts real calendar dates, leap days included', () => {
    for (const d of ['2026-01-01', '2026-12-31', '2024-02-29', '2000-02-29', '2026-02-28']) expect(isRealIsoDate(d)).toBe(true)
  })
  it('refuses a date the calendar does not have — V8 would roll 30 Feb over to 2 Mar', () => {
    for (const d of ['2026-02-30', '2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-06-00', '2026-13-45']) {
      expect(isRealIsoDate(d)).toBe(false)
    }
  })
  it('refuses anything that is not YYYY-MM-DD', () => {
    for (const d of ['05/10/2026', '2026-6-1', '2026-06-01T00:00:00Z', '', null, undefined, 20260601]) expect(isRealIsoDate(d)).toBe(false)
  })
})

// LEAVEGUARD.1 — the reads the leave guard judges a requester's tier from.
describe('getOrgAdminLocationIdsByProfile', () => {
  const dbWith = ({ grants = [], locations = [], grantError = null, locError = null } = {}) => fakeDb((q) => {
    if (q.table === 'profile_organizations') return grantError ? { data: null, error: grantError } : { data: grants, error: null }
    if (q.table === 'locations') return locError ? { data: null, error: locError } : { data: locations, error: null }
    throw new Error(q.table)
  })

  it('maps each org admin to the studios of their organisations, org_admin grants only, paged and ordered', async () => {
    const db = dbWith({
      grants: [{ profile_id: 'p1', organization_id: 'org-1', role: 'org_admin' }],
      locations: [{ id: 'loc-1', organization_id: 'org-1' }, { id: 'loc-2', organization_id: 'org-1' }],
    })
    const { byProfile, error } = await getOrgAdminLocationIdsByProfile(db, ['p1', 'p2', 'p1'])
    expect(error).toBeNull()
    expect(byProfile.get('p1')).toEqual(['loc-1', 'loc-2'])
    expect(byProfile.has('p2')).toBe(false)
    const grantRead = queriesOf(db, 'profile_organizations')[0]
    expect(grantRead.calls).toContainEqual(['in', 'profile_id', ['p1', 'p2']])
    expect(grantRead.calls).toContainEqual(['eq', 'role', 'org_admin'])
    expect(grantRead.calls.some(([op]) => op === 'range')).toBe(true)
    expect(queriesOf(db, 'locations')[0].calls).toContainEqual(['in', 'organization_id', ['org-1']])
  })

  it('no grants: no locations read; no ids: no read at all', async () => {
    let db = dbWith()
    expect((await getOrgAdminLocationIdsByProfile(db, ['p1'])).byProfile.size).toBe(0)
    expect(queriesOf(db, 'locations')).toHaveLength(0)
    db = dbWith()
    await getOrgAdminLocationIdsByProfile(db, [])
    expect(db.queries).toHaveLength(0)
  })

  it('either read failing is returned as the error, never as "no org admin"', async () => {
    expect((await getOrgAdminLocationIdsByProfile(dbWith({ grantError: { message: 'a' } }), ['p1'])).error).toEqual({ message: 'a' })
    const db = dbWith({ grants: [{ profile_id: 'p1', organization_id: 'org-1', role: 'org_admin' }], locError: { message: 'b' } })
    expect((await getOrgAdminLocationIdsByProfile(db, ['p1'])).error).toEqual({ message: 'b' })
  })
})

describe('getProfileLocationIds — memberships carry the per-studio role', () => {
  it('returns ids and { location_id, role } rows from one read', async () => {
    const db = fakeDb(() => ({ data: [{ location_id: 'loc-1', role: 'manager' }, { location_id: 'loc-2', role: 'staff' }], error: null }))
    expect(await getProfileLocationIds(db, 'p1')).toEqual({
      ids: ['loc-1', 'loc-2'],
      memberships: [{ location_id: 'loc-1', role: 'manager' }, { location_id: 'loc-2', role: 'staff' }],
      error: null,
    })
  })
})
