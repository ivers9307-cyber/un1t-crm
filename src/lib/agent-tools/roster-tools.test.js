import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/roster-read', async (orig) => ({ ...(await orig()), fetchApiShiftRows: vi.fn() }))
vi.mock('@/lib/roster-write', async (orig) => ({ ...(await orig()), upsertShiftAssignment: vi.fn() }))
vi.mock('@/lib/report-generator', async (orig) => ({ ...(await orig()), fetchScheduledShiftRows: vi.fn() }))
vi.mock('@/lib/time-off-leave', async (orig) => ({
  ...(await orig()), getHolidayAllowance: vi.fn(), getPendingHolidayDays: vi.fn(),
}))

import { fetchApiShiftRows } from '@/lib/roster-read'
import { upsertShiftAssignment } from '@/lib/roster-write'
import { fetchScheduledShiftRows } from '@/lib/report-generator'
import { getHolidayAllowance, getPendingHolidayDays } from '@/lib/time-off-leave'
import { runTool } from './registry.js'
import getShifts from './get-shifts.js'
import getTimeOff from './get-time-off.js'
import getHolidayAllowanceTool from './get-holiday-allowance.js'
import listStaff from './list-staff.js'
import listShiftTemplates from './list-shift-templates.js'
import createShift from './create-shift.js'
import staffHoursReport from './staff-hours-report.js'
import staffCostReport from './staff-cost-report.js'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const OTHER = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b02'
const TPL = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1c01'
// 2031-11-01 12:00 UTC: the 1st in Dublin, in a year the real clock has not reached
// (so a default year read off the real clock shows).
const NOW_MS = Date.UTC(2031, 10, 1, 12, 0, 0)

function auth(role = 'manager') {
  const locations = [{ id: DUB, name: 'Dublin Studio', timezone: 'Europe/Dublin', organization_id: 'org-1' }]
  return {
    token: 't',
    clientId: 'client-1',
    scopes: [],
    extra: {
      user: {
        id: ME,
        full_name: 'Pat',
        role,
        isMaster: false,
        locations,
        activeLocation: locations[0],
        rolesByLocation: { [DUB]: role },
        assignmentsByLocation: { [DUB]: { role, permissions: { assistant: true } } },
      },
      enabledOrgIds: ['org-1'],
      assistantAnywhere: true,
    },
  }
}

/** A chainable stand-in for the supabase builder: records every call, answers from `tables`. */
function makeDb(tables = {}) {
  const queries = []
  const db = {
    rpc: vi.fn(async () => ({ data: 1, error: null })),
    from: vi.fn((table) => {
      const q = { table, calls: [] }
      queries.push(q)
      const answer = () => {
        const t = typeof tables[table] === 'function' ? tables[table](q) : tables[table]
        return t ?? { data: [], error: null }
      }
      const b = {}
      for (const m of ['select', 'eq', 'in', 'lte', 'gte', 'neq', 'order', 'limit', 'is']) {
        b[m] = (...args) => { q.calls.push([m, ...args]); return b }
      }
      b.maybeSingle = async () => answer()
      b.insert = async () => ({ error: null })
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    }),
  }
  const on = (table) => queries.filter((q) => q.table === table)
  return { db, on }
}
const used = (q, method, ...args) => q.calls.some((c) => c[0] === method && args.every((a, i) => c[i + 1] === a))
const run = (tool, input, role, db) => runTool(tool, input, auth(role), { db, nowMs: NOW_MS })

beforeEach(() => { vi.clearAllMocks() })

describe('get_shifts', () => {
  it('refuses a range over 31 days and a bad date', async () => {
    const { db } = makeDb()
    const wide = await run(getShifts, { start: '2026-11-01', end: '2026-12-15' }, 'manager', db)
    expect(wide).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(wide.message).toMatch(/31/)
    const bad = await run(getShifts, { start: '2026-02-30', end: '2026-03-02' }, 'manager', db)
    expect(bad).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(bad.message).toMatch(/real dates/)
    expect(fetchApiShiftRows).not.toHaveBeenCalled()
  })

  it('passes publishedOnly=true for staff and false for a manager, judging the viewer per studio', async () => {
    fetchApiShiftRows.mockResolvedValue({ rows: [], error: null })
    const { db } = makeDb()
    await run(getShifts, { start: '2026-11-02', end: '2026-11-08' }, 'staff', db)
    await run(getShifts, { start: '2026-11-02', end: '2026-11-08' }, 'manager', db)
    const [staffCall, managerCall] = fetchApiShiftRows.mock.calls.map((c) => c[1])
    expect(staffCall).toMatchObject({ locationIds: [DUB], startDate: '2026-11-02', endDate: '2026-11-08', publishedOnly: true })
    expect(staffCall.viewer.id).toBe(ME)
    expect(staffCall.viewer.isManagerAt(DUB)).toBe(false)
    expect(managerCall.publishedOnly).toBe(false)
    expect(managerCall.viewer.isManagerAt(DUB)).toBe(true)
  })

  it('returns effective hours, names the zone and lists days no published roster covers', async () => {
    fetchApiShiftRows.mockResolvedValue({
      rows: [{
        id: 'a1', shift_date: '2026-11-02', profile_id: OTHER, profiles: { full_name: 'Sam' },
        start_time_override: '07:30:00', end_time_override: null,
        block_start_time: '06:00:00', block_end_time: '12:00:00', shift_templates: { name: 'Morning' },
      }],
      error: null,
    })
    const { db, on } = makeDb({ rosters: { data: [{ period_start: '2026-11-02', period_end: '2026-11-03' }], error: null } })
    const r = await run(getShifts, { start: '2026-11-02', end: '2026-11-04' }, 'staff', db)
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({
      studio: { id: DUB, name: 'Dublin Studio' },
      zone: 'Europe/Dublin',
      shifts: [{ id: 'a1', date: '2026-11-02', start: '07:30', end: '12:00', profile_id: OTHER, name: 'Sam', template: 'Morning' }],
      unpublished_days: ['2026-11-04'],
      capped: false,
    })
    expect(used(on('rosters')[0], 'eq', 'location_id', DUB)).toBe(true)
  })

  it('says which rows are published for a manager and leaves the flag off for staff', async () => {
    const row = (id, published) => ({ id, shift_date: '2026-11-02', profile_id: OTHER, published, profiles: null, shift_templates: null })
    fetchApiShiftRows.mockResolvedValue({ rows: [row('a1', true), row('a2', false)], error: null })
    const { db } = makeDb()
    const manager = await run(getShifts, { start: '2026-11-02', end: '2026-11-02' }, 'manager', db)
    expect(manager.data.shifts.map((s) => s.published)).toEqual([true, false])
    const staff = await run(getShifts, { start: '2026-11-02', end: '2026-11-02' }, 'staff', db)
    expect(staff.data.shifts.every((s) => !('published' in s))).toBe(true)
  })

  it('caps the list at 50 rows and says so', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, shift_date: '2026-11-02', profile_id: OTHER, profiles: null, shift_templates: null }))
    fetchApiShiftRows.mockResolvedValue({ rows, error: null })
    const { db } = makeDb()
    const r = await run(getShifts, { start: '2026-11-02', end: '2026-11-02' }, 'manager', db)
    expect(r.data.shifts).toHaveLength(50)
    expect(r.data.capped).toBe(true)
  })

  it('answers a failed read as tool_failed, never as an empty week', async () => {
    fetchApiShiftRows.mockResolvedValue({ rows: [], error: { message: 'boom' } })
    const { db } = makeDb()
    const r = await run(getShifts, { start: '2026-11-02', end: '2026-11-08' }, 'manager', db)
    expect(r).toMatchObject({ ok: false, code: 'tool_failed' })
  })
})

describe('get_time_off', () => {
  const rows = [{ id: 't1', profile_id: OTHER, type: 'holiday', status: 'approved', start_date: '2026-11-03', end_date: '2026-11-04', reason: 'trip' }]
  const tables = { time_off_requests: { data: rows, error: null }, profiles: { data: [{ id: OTHER, full_name: 'Sam' }], error: null } }

  it('filters to the caller for staff only', async () => {
    const staff = makeDb(tables)
    await run(getTimeOff, { start: '2026-11-01', end: '2026-11-30' }, 'staff', staff.db)
    expect(used(staff.on('time_off_requests')[0], 'eq', 'profile_id', ME)).toBe(true)
    expect(used(staff.on('time_off_requests')[0], 'eq', 'location_id', DUB)).toBe(true)

    const manager = makeDb(tables)
    const r = await run(getTimeOff, { start: '2026-11-01', end: '2026-11-30' }, 'manager', manager.db)
    expect(manager.on('time_off_requests')[0].calls.some((c) => c[0] === 'eq' && c[1] === 'profile_id')).toBe(false)
    expect(r.data.time_off).toEqual([{
      id: 't1', profile_id: OTHER, name: 'Sam', type: 'holiday', status: 'approved',
      start: '2026-11-03', end: '2026-11-04', reason: 'trip',
    }])
    expect(r.data.capped).toBe(false)
  })

  it('refuses a range over 366 days and a reversed one', async () => {
    const { db } = makeDb()
    const wide = await run(getTimeOff, { start: '2026-01-01', end: '2027-06-01' }, 'manager', db)
    expect(wide).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(wide.message).toMatch(/366/)
    const reversed = await run(getTimeOff, { start: '2026-11-05', end: '2026-11-01' }, 'manager', db)
    expect(reversed).toMatchObject({ ok: false, code: 'invalid_input' })
  })
})

describe('get_holiday_allowance', () => {
  beforeEach(() => {
    getHolidayAllowance.mockResolvedValue({ allowance: { exists: true, total_days: 20, used_days: 5, carried_over: 2 }, error: null })
    getPendingHolidayDays.mockResolvedValue({ days: 3, error: null })
  })

  it('answers the caller\'s own allowance for anyone, for this year at the studio', async () => {
    const { db, on } = makeDb()
    const r = await run(getHolidayAllowanceTool, {}, 'staff', db)
    expect(r.data).toEqual({ profile_id: ME, year: 2031, entitlement_days: 22, used_days: 5, pending_days: 3, remaining_days: 17 })
    expect(getHolidayAllowance).toHaveBeenCalledWith(db, ME, 2031)
    expect(getPendingHolidayDays).toHaveBeenCalledWith(db, ME, 2031)
    expect(on('profile_locations')).toHaveLength(0)
  })

  it('for another person needs a manager and a membership at the studio', async () => {
    const staff = makeDb()
    const refused = await run(getHolidayAllowanceTool, { profile_id: OTHER }, 'staff', staff.db)
    expect(refused).toMatchObject({ ok: false, code: 'forbidden' })
    expect(refused.message).toMatch(/manager/i)
    expect(getHolidayAllowance).not.toHaveBeenCalled()

    const stranger = makeDb({ profile_locations: { data: null, error: null } })
    const notHere = await run(getHolidayAllowanceTool, { profile_id: OTHER }, 'manager', stranger.db)
    expect(notHere).toMatchObject({ ok: false, code: 'not_found' })
    expect(notHere.message).toMatch(/not found/i)
    expect(used(stranger.on('profile_locations')[0], 'eq', 'location_id', DUB)).toBe(true)
    expect(getHolidayAllowance).not.toHaveBeenCalled()

    const member = makeDb({ profile_locations: { data: { profile_id: OTHER }, error: null } })
    const ok = await run(getHolidayAllowanceTool, { profile_id: OTHER, year: 2025 }, 'manager', member.db)
    expect(ok.data).toMatchObject({ profile_id: OTHER, year: 2025, remaining_days: 17 })
    expect(getHolidayAllowance).toHaveBeenCalledWith(member.db, OTHER, 2025)
  })

  it('refuses a year that is not a four-digit year', async () => {
    const { db } = makeDb()
    const r = await run(getHolidayAllowanceTool, { year: 'abc' }, 'staff', db)
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
  })
})

describe('list_staff', () => {
  it('never returns email, phone or pay fields', async () => {
    const { db, on } = makeDb({
      profile_locations: { data: [{ profile_id: OTHER, role: 'head_coach' }], error: null },
      profiles: {
        data: [{
          id: OTHER, full_name: 'Sam', employment_type: 'contractor', active: true,
          email: 'sam@x.ie', phone: '087', annual_salary: 50000, hourly_rate: 20,
        }],
        error: null,
      },
    })
    const r = await run(listStaff, {}, 'manager', db)
    expect(r.ok).toBe(true)
    expect(r.data.staff).toHaveLength(1)
    expect(Object.keys(r.data.staff[0]).sort()).toEqual(['employment_type', 'id', 'name', 'role'])
    expect(r.data.staff[0]).toEqual({ id: OTHER, name: 'Sam', role: 'head_coach', employment_type: 'contractor' })
    const select = on('profiles')[0].calls.find((c) => c[0] === 'select')[1]
    expect(select).not.toMatch(/email|phone|salary|rate|\*/)
    expect(used(on('profiles')[0], 'eq', 'active', true)).toBe(true)
  })

  it('is for managers only', async () => {
    const { db } = makeDb()
    expect(await run(listStaff, {}, 'staff', db)).toMatchObject({ ok: false, code: 'forbidden' })
  })
})

describe('list_shift_templates', () => {
  it('lists the studio\'s active templates, for managers', async () => {
    const tpl = { id: TPL, name: 'Morning', start_time: '06:00:00', end_time: '12:00:00', role_label: 'Floor Coach' }
    const { db, on } = makeDb({ shift_templates: { data: [tpl], error: null } })
    const r = await run(listShiftTemplates, {}, 'head_coach', db)
    expect(r.data).toEqual({ studio: { id: DUB, name: 'Dublin Studio' }, templates: [tpl], capped: false })
    expect(used(on('shift_templates')[0], 'eq', 'location_id', DUB)).toBe(true)
    expect(used(on('shift_templates')[0], 'eq', 'active', true)).toBe(true)
    expect(await run(listShiftTemplates, {}, 'staff', db)).toMatchObject({ ok: false, code: 'forbidden' })
  })
})

describe('create_shift', () => {
  it('calls upsertShiftAssignment with actorId = the caller and is a write tool', async () => {
    upsertShiftAssignment.mockResolvedValue({
      blockId: 'b1', assignment: { id: 'a1', block_id: 'b1', profile_id: OTHER, status: 'scheduled' },
      template: { name: 'Morning', start_time: '06:00:00' }, created: true, error: null,
    })
    const { db } = makeDb()
    const input = { profile_id: OTHER, shift_template_id: TPL, date: '2026-11-03' }
    const r = await run(createShift, input, 'manager', db)
    expect(createShift.writes).toBe(true)
    expect(upsertShiftAssignment).toHaveBeenCalledWith(db, {
      locationId: DUB, profileId: OTHER, shiftTemplateId: TPL, shiftDate: '2026-11-03', actorId: ME,
    })
    expect(r.data).toMatchObject({ success: true, created: true, date: '2026-11-03', template: 'Morning', assignment: { id: 'a1' } })
  })

  it('answers the helper\'s refusals with a code and a database failure as tool_failed', async () => {
    const { db } = makeDb()
    const input = { profile_id: OTHER, shift_template_id: TPL, date: '2026-11-03' }
    upsertShiftAssignment.mockResolvedValueOnce({ error: { message: 'profile not linked to this location' } })
    expect(await run(createShift, input, 'manager', db)).toEqual({ ok: false, code: 'not_found', message: 'profile not linked to this location' })
    upsertShiftAssignment.mockResolvedValueOnce({ error: { message: 'shift_template not found' } })
    expect(await run(createShift, input, 'manager', db)).toMatchObject({ ok: false, code: 'not_found' })
    // notRosterableError carries a code of its own: a refusal, not a database failure.
    upsertShiftAssignment.mockResolvedValueOnce({
      error: { code: 'profile_not_rosterable', message: 'Sam is deactivated and cannot be rostered. Reactivate them in Settings > Staff first.' },
    })
    const deactivated = await run(createShift, input, 'manager', db)
    expect(deactivated).toMatchObject({ ok: false, code: 'conflict' })
    expect(deactivated.message).toMatch(/deactivated/)
    // A PostgREST error has details and hint.
    upsertShiftAssignment.mockResolvedValueOnce({ error: { message: 'connection reset', code: '08006', details: '', hint: '' } })
    const failed = await run(createShift, input, 'manager', db)
    expect(failed).toMatchObject({ ok: false, code: 'tool_failed' })
    expect(failed.message).not.toMatch(/connection reset/)
  })

  it('refuses a date the calendar does not have, and staff', async () => {
    const { db } = makeDb()
    const bad = await run(createShift, { profile_id: OTHER, shift_template_id: TPL, date: '2026-02-30' }, 'manager', db)
    expect(bad).toMatchObject({ ok: false, code: 'invalid_input' })
    const staff = await run(createShift, { profile_id: OTHER, shift_template_id: TPL, date: '2026-11-03' }, 'staff', db)
    expect(staff).toMatchObject({ ok: false, code: 'forbidden' })
    expect(upsertShiftAssignment).not.toHaveBeenCalled()
  })
})

describe('staff reports', () => {
  const shifts = [
    { profile_id: OTHER, profiles: { full_name: 'Sam' }, shift_templates: { start_time: '06:00:00', end_time: '12:00:00' }, start_time_override: null, end_time_override: null },
    { profile_id: OTHER, profiles: { full_name: 'Sam' }, shift_templates: { start_time: '06:00:00', end_time: '12:00:00' }, start_time_override: '08:00:00', end_time_override: null },
  ]
  const tables = {
    profile_locations: { data: [{ profile_id: OTHER }], error: null },
    profiles: { data: [{ id: OTHER, full_name: 'Sam', employment_type: 'contractor', annual_salary: null, hourly_rate: 20, contracted_hours_per_week: null }], error: null },
  }
  beforeEach(() => { fetchScheduledShiftRows.mockResolvedValue({ rows: shifts, error: null }) })
  const period = { start: '2026-11-01', end: '2026-11-30' }

  it('staff_hours_report totals effective hours per person, for a head coach, with no pay', async () => {
    const { db } = makeDb(tables)
    const r = await run(staffHoursReport, period, 'head_coach', db)
    expect(fetchScheduledShiftRows).toHaveBeenCalledWith(db, { locationId: DUB, periodStart: '2026-11-01', periodEnd: '2026-11-30' })
    expect(r.data).toMatchObject({ staff: [{ profile_id: OTHER, name: 'Sam', hours: 10 }], total_hours: 10, capped: false })
    expect(JSON.stringify(r.data)).not.toMatch(/rate|cost|salary/)
  })

  it('staff_cost_report is refused for a head coach and allowed for a manager', async () => {
    const { db } = makeDb(tables)
    expect(await run(staffCostReport, period, 'head_coach', db)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(fetchScheduledShiftRows).not.toHaveBeenCalled()
    const r = await run(staffCostReport, period, 'manager', db)
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({
      currency: 'EUR', total_cost: 200,
      staff: [{ profile_id: OTHER, name: 'Sam', hours: 10, hourly_rate: 20, cost: 200 }],
    })
  })

  it('refuses a period over 366 days', async () => {
    const { db } = makeDb(tables)
    const r = await run(staffHoursReport, { start: '2025-01-01', end: '2026-11-30' }, 'manager', db)
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('answers a failed shift read as tool_failed, not as zero hours', async () => {
    fetchScheduledShiftRows.mockResolvedValue({ rows: [], error: 'Failed to load scheduled shifts: boom' })
    const { db } = makeDb(tables)
    expect(await run(staffHoursReport, period, 'manager', db)).toMatchObject({ ok: false, code: 'tool_failed' })
  })
})
