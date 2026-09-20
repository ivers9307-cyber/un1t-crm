// LEAVE.2 — pure rules behind the time-off routes.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
const { logWarn } = await import('@/lib/log')
import {
  leaveScopeOrFilter, canDecideTimeOff, timeOffApproverIdsFrom, entitlementDays,
  clashWindow, bucketClashCounts, getHolidayAllowance, ensureHolidayAllowanceRow,
  getNonWorkingDates,
} from './time-off-leave.js'
import { fakeDb, queriesOf } from './time-off.test-helpers.js'

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
