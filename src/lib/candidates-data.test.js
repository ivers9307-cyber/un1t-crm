// CANDIDATES.1 — the reads behind GET /api/schedule/blocks/[id]/candidates.
// The rules are pinned in shared/candidates.test.js; this pins WHICH rows are
// read, which columns (never pay), which audience reads what, and that a
// failed read is "not checked", never an all-clear.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sibling-locations', () => ({ siblingLocationIds: vi.fn() }))
vi.mock('./working-time-data', () => ({ readOrgShiftRows: vi.fn() }))
vi.mock('./availability-server', () => ({ readStudioAvailability: vi.fn() }))
vi.mock('./log', async () => ({ ...(await vi.importActual('./log')), logWarn: vi.fn() }))

import { siblingLocationIds } from './sibling-locations'
import { readOrgShiftRows } from './working-time-data'
import { readStudioAvailability } from './availability-server'
import { loadBlockCandidates, readEligibleMembers, readContractedHours } from './candidates-data'

const NAMES = { ann: 'Ann Free', con: 'Con Tractor', off: 'Off Duty', gone: 'Gone Away', onblk: 'On Block', nul: 'Nul Active' }
const link = (profile_id, over = {}) => ({
  profile_id, role: 'staff',
  profiles: { id: profile_id, full_name: NAMES[profile_id], active: true, deleted_at: null, employment_type: 'fte', ...over },
})
const LINKS = [
  link('ann'),
  link('con', { employment_type: 'contractor' }),
  link('off', { active: false }),
  link('gone', { active: false, deleted_at: '2026-09-01T00:00:00Z' }),
  link('onblk'),
  link('nul', { active: null }), // mig 626: a NULL active still counts
]
const BLOCK = {
  id: 'blk', location_id: 'loc1', block_date: '2026-09-23', start_time: '10:00:00', end_time: '12:00:00',
  shift_templates: { name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  // con's cancelled tombstone does not hold the seat (ROSTER-FIX.1 D4).
  shift_assignments: [{ profile_id: 'onblk', status: 'scheduled' }, { profile_id: 'con', status: 'cancelled' }],
}
const SHIFTS = [{
  profile_id: 'ann', block_id: 'x1', block_date: '2026-09-21', location_id: 'loc2', location_name: 'Studio South', name: 'Class',
  status: 'scheduled', start_time_override: null, end_time_override: null, start_time: '09:00:00', end_time: '13:00:00',
  shift_templates: { start_time: '09:00:00', end_time: '13:00:00' },
}]
const LEAVE = [{ id: 'l1', profile_id: 'con', type: 'holiday', start_date: '2026-09-22', end_date: '2026-09-24' }]
const RULES = [
  { id: 'r1', profile_id: 'onblk', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: null },
  { id: 'r2', profile_id: 'nul', kind: 'weekly', weekday: 'wed', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null },
]
const COMP = [
  { profile_id: 'ann', contracted_hours_per_week: '39.0' },
  { profile_id: 'nul', contracted_hours_per_week: null },
]

function mockDb({ links = LINKS, leave = LEAVE, comp = COMP, fail = {} } = {}) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, select: null, eqs: [], ins: [], lte: null, gte: null, orders: [], range: null }
      log.push(q)
      const ids = () => q.ins.find(([c]) => c === 'profile_id')?.[1] || []
      const answer = () => {
        if (fail[table]) return { data: null, error: { message: `${table} unreadable` } }
        if (table === 'profile_locations') {
          const [from, to] = q.range || [0, Infinity]
          return { data: links.slice(from, to + 1), error: null }
        }
        if (table === 'time_off_requests') return { data: leave.filter((l) => ids().includes(l.profile_id)), error: null }
        if (table === 'profile_compensation') return { data: comp.filter((c) => ids().includes(c.profile_id)), error: null }
        throw new Error(`unexpected table ${table}`)
      }
      const chain = {
        select: (s) => { q.select = s; return chain },
        eq: (c, v) => { q.eqs.push([c, v]); return chain },
        in: (c, v) => { q.ins.push([c, v]); return chain },
        lte: (c, v) => { q.lte = [c, v]; return chain },
        gte: (c, v) => { q.gte = [c, v]; return chain },
        order: (c) => { q.orders.push(c); return chain },
        range: (f, t) => { q.range = [f, t]; return chain },
        then: (onF, onR) => Promise.resolve().then(answer).then(onF, onR),
      }
      return chain
    },
  }
}
const read = (db, table) => db.log.find((q) => q.table === table)

beforeEach(() => {
  siblingLocationIds.mockReset().mockResolvedValue({ ids: ['loc2'], error: null })
  readOrgShiftRows.mockReset().mockResolvedValue({ shifts: SHIFTS, error: null })
  readStudioAvailability.mockReset().mockResolvedValue({ data: RULES, error: null })
})

describe('readEligibleMembers', () => {
  it('active members of the studio only, minus the live people on the block; names and employment type, no pay', async () => {
    const db = mockDb()
    const out = await readEligibleMembers(db, { locationId: 'loc1', excludeIds: ['onblk'] })
    expect(out.error).toBeNull()
    expect(out.members).toEqual([
      { profile_id: 'ann', full_name: 'Ann Free', role: 'staff', employment_type: 'fte' },
      { profile_id: 'con', full_name: 'Con Tractor', role: 'staff', employment_type: 'contractor' },
      { profile_id: 'nul', full_name: 'Nul Active', role: 'staff', employment_type: 'fte' },
    ])
    const q = read(db, 'profile_locations')
    expect(q.select).toBe('profile_id, role, profiles!inner(id, full_name, active, deleted_at, employment_type)')
    expect(q.eqs).toEqual([['location_id', 'loc1']])
    expect(q.orders).toEqual(['profile_id'])
    expect(q.range).toEqual([0, 999])
  })

  it('pages past 1,000 members', async () => {
    const links = Array.from({ length: 1001 }, (_, i) => ({ profile_id: `p${i}`, role: 'staff', profiles: { id: `p${i}`, full_name: `P ${i}`, active: true, deleted_at: null, employment_type: 'fte' } }))
    const db = mockDb({ links })
    const out = await readEligibleMembers(db, { locationId: 'loc1' })
    expect(db.log.filter((q) => q.table === 'profile_locations')).toHaveLength(2)
    expect(out.members).toHaveLength(1001)
  })
})

describe('readContractedHours', () => {
  it('names its one column, chunks at 200, keeps positive numbers only', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`)
    const db = mockDb({ comp: [{ profile_id: 'p0', contracted_hours_per_week: '37.5' }, { profile_id: 'p1', contracted_hours_per_week: 0 }] })
    const out = await readContractedHours(db, ids)
    const reads = db.log.filter((q) => q.table === 'profile_compensation')
    expect(reads.map((q) => q.ins[0][1].length)).toEqual([200, 200, 50])
    expect(reads[0].select).toBe('profile_id, contracted_hours_per_week')
    expect([...out.byProfile]).toEqual([['p0', 37.5]])
  })

  it('nobody: no read', async () => {
    const db = mockDb()
    expect(await readContractedHours(db, [])).toEqual({ byProfile: new Map(), error: null })
    expect(db.log).toHaveLength(0)
  })
})

describe('loadBlockCandidates — manager', () => {
  it('reads the week at every studio of the organisation, leave on the day, availability, and employees\' contracts', async () => {
    const db = mockDb()
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(siblingLocationIds).toHaveBeenCalledWith(db, 'loc1')
    expect(readOrgShiftRows).toHaveBeenCalledWith(db, {
      locationId: 'loc1', scopeIds: ['loc1', 'loc2'], profileIds: ['ann', 'con', 'nul'], from: '2026-09-20', to: '2026-09-28',
    })
    const leave = read(db, 'time_off_requests')
    expect(leave.select).toBe('id, profile_id, type, start_date, end_date')
    expect(leave.eqs).toEqual([['status', 'approved']])
    expect(leave.lte).toEqual(['start_date', '2026-09-23'])
    expect(leave.gte).toEqual(['end_date', '2026-09-23'])
    expect(readStudioAvailability).toHaveBeenCalledWith(db, { locationId: 'loc1', startDate: '2026-09-23', endDate: '2026-09-23' })
    expect(read(db, 'profile_compensation').ins).toEqual([['profile_id', ['ann', 'nul']]]) // employees only
    expect(out.error).toBeNull()
    expect(out.checked).toEqual({ shifts: true, cross_studio: true, leave: true, availability: true, contract: true })
    expect(out.candidates.map((c) => [c.profile_id, c.tier])).toEqual([['ann', 'ready'], ['nul', 'unavailable'], ['con', 'blocked']])
    expect(out.candidates[0]).toMatchObject({ contracted_hours: 39, week_minutes: 240, reason: 'Free · 4h of 39h this week' })
    expect(out.candidates[2].on_leave).toMatchObject({ type: 'holiday' })
  })

  it('never selects or returns a pay column', async () => {
    const db = mockDb()
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(db.log.map((q) => q.select).join(' ')).not.toMatch(/salary|hourly_rate|overtime|annual_leave/)
    expect(JSON.stringify(out)).not.toMatch(/salary|hourly_rate|overtime|rate"/)
  })

  it('a failed side read is "not checked" and the list still comes back; a failed member read is an error', async () => {
    readOrgShiftRows.mockResolvedValue({ shifts: [], error: { message: 'assignments unreadable' } })
    readStudioAvailability.mockResolvedValue({ data: null, error: { message: 'relation "staff_unavailability" does not exist' } })
    siblingLocationIds.mockResolvedValue({ ids: [], error: { message: 'siblings unreadable' } })
    const db = mockDb({ fail: { time_off_requests: true, profile_compensation: true } })
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(out.checked).toEqual({ shifts: false, cross_studio: false, leave: false, availability: false, contract: false })
    expect(readOrgShiftRows.mock.calls[0][1].scopeIds).toEqual(['loc1'])
    expect(out.candidates.map((c) => c.profile_id)).toEqual(['ann', 'con', 'nul'])
    expect(out.candidates.every((c) => c.free === null && c.on_leave === null && c.contracted_hours === null)).toBe(true)

    const broken = await loadBlockCandidates(mockDb({ fail: { profile_locations: true } }), { block: BLOCK, audience: 'manager' })
    expect(broken.error).toEqual({ message: 'profile_locations unreadable' })
  })

  it('nobody eligible: no further reads', async () => {
    const db = mockDb({ links: [link('onblk')] })
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'manager' })
    expect(out).toMatchObject({ candidates: [], untimed: 0, error: null })
    expect(siblingLocationIds).not.toHaveBeenCalled()
    expect(readOrgShiftRows).not.toHaveBeenCalled()
  })
})

describe('loadBlockCandidates — colleague', () => {
  it('reads shifts only: no leave, no availability, no contracts; free or working only', async () => {
    const db = mockDb()
    const out = await loadBlockCandidates(db, { block: BLOCK, audience: 'colleague' })
    expect(db.log.map((q) => q.table)).toEqual(['profile_locations'])
    expect(readStudioAvailability).not.toHaveBeenCalled()
    expect(readOrgShiftRows).toHaveBeenCalledTimes(1)
    expect(out.checked).toEqual({ shifts: true, cross_studio: true })
    expect(out.candidates.map((c) => c.profile_id)).toEqual(['ann', 'con', 'nul'])
    expect(Object.keys(out.candidates[0]).sort()).toEqual(['free', 'full_name', 'profile_id', 'rank', 'reason', 'role', 'tier'])
  })
})
