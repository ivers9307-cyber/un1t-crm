// WORKTIME.1 — the working-time reader. The rules are pinned in
// shared/working-time.test.js; this file pins the READ: which studios, which
// people, which columns, and that a failure is never an all-clear.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sibling-locations', () => ({ siblingLocationIds: vi.fn() }))
vi.mock('./log', async () => ({ ...(await vi.importActual('./log')), logWarn: vi.fn() }))

import { siblingLocationIds } from './sibling-locations'
import { loadWorkingTimeShifts, readOrgShiftRows, COUNT_UNPUBLISHED_ELSEWHERE, SUBTRACT_APPROVED_LEAVE } from './working-time-data'

const PEOPLE = [
  { id: 'emp', full_name: 'Sam Demo', employment_type: 'fte' },
  { id: 'con', full_name: 'Max Beta', employment_type: 'contractor' },
]
const NAMES = { loc1: 'Studio North', loc2: 'Studio South', loc9: 'Another Organisation' }

const row = (id, profile_id, loc, date, start, end, over = {}, rosterStatus = 'published') => ({
  id, profile_id, status: 'scheduled', start_time_override: null, end_time_override: null,
  shift_blocks: {
    id: `b-${id}`, location_id: loc, block_date: date, start_time: start, end_time: end, roster_id: rosterStatus ? `r-${id}` : null,
    shift_templates: { name: 'Class', start_time: start, end_time: end }, locations: { name: NAMES[loc] },
    rosters: rosterStatus ? { status: rosterStatus } : null,
  },
  ...over,
})

function mockDb({ people = PEOPLE, assignments = [], leave = [], failPeople = false, failAssignments = false, failLeave = false, throwOn = null } = {}) {
  const log = { profiles: [], assignments: [], leave: [] }
  return {
    log,
    from(table) {
      if (throwOn === table) throw new Error(`${table}: client exploded`)
      if (table === 'time_off_requests') {
        const q = { select: null, ids: null, eqs: [], lte: null, gte: null, orders: [], from: 0, to: Infinity }
        log.leave.push(q)
        const chain = {
          select: (s) => { q.select = s; return chain },
          in: (_c, v) => { q.ids = v; return chain },
          eq: (c, v) => { q.eqs.push([c, v]); return chain },
          lte: (c, v) => { q.lte = [c, v]; return chain },
          gte: (c, v) => { q.gte = [c, v]; return chain },
          order: (c) => { q.orders.push(c); return chain },
          range: (f, t) => { q.from = f; q.to = t; return chain },
          then: (onF, onR) => Promise.resolve(failLeave
            ? { data: null, error: { message: 'leave unreadable' } }
            : { data: leave.filter((l) => q.ids.includes(l.profile_id)).slice(q.from, q.to + 1), error: null }).then(onF, onR),
        }
        return chain
      }
      if (table === 'profiles') {
        const q = { select: null, ids: null }
        log.profiles.push(q)
        const chain = {
          select: (s) => { q.select = s; return chain },
          in: (_c, v) => { q.ids = v; return chain },
          then: (onF, onR) => Promise.resolve(failPeople
            ? { data: null, error: { message: 'profiles unreadable' } }
            : { data: people.filter((p) => q.ids.includes(p.id)), error: null }).then(onF, onR),
        }
        return chain
      }
      if (table === 'shift_assignments') {
        const q = { select: null, profileIds: null, locIds: null, gte: null, lte: null, orders: [], from: 0, to: Infinity }
        log.assignments.push(q)
        const chain = {
          select: (s) => { q.select = s; return chain },
          in: (c, v) => { if (c === 'profile_id') q.profileIds = v; else if (c === 'shift_blocks.location_id') q.locIds = v; return chain },
          gte: (c, v) => { q.gte = [c, v]; return chain },
          lte: (c, v) => { q.lte = [c, v]; return chain },
          order: (c) => { q.orders.push(c); return chain },
          range: (f, t) => { q.from = f; q.to = t; return chain },
          // Deliberately NOT filtered by studio: the reader must re-check the
          // organisation boundary itself.
          then: (onF, onR) => Promise.resolve(failAssignments
            ? { data: null, error: { message: 'assignments unreadable' } }
            : { data: assignments.filter((a) => q.profileIds.includes(a.profile_id)).slice(q.from, q.to + 1), error: null }).then(onF, onR),
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const ARGS = { locationId: 'loc1', profileIds: ['emp', 'con'], from: '2026-09-20', to: '2026-09-28' }

beforeEach(() => {
  siblingLocationIds.mockReset().mockResolvedValue({ ids: ['loc2'], error: null })
})

describe('loadWorkingTimeShifts', () => {
  it('reads this organisation\'s studios only, and drops a row from anywhere else even if it comes back', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a2', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00'),
      row('a9', 'emp', 'loc9', '2026-09-23', '06:00:00', '08:00:00'),
    ] })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(siblingLocationIds).toHaveBeenCalledWith(db, 'loc1')
    expect(db.log.assignments[0].locIds).toEqual(['loc1', 'loc2'])
    expect(out.shifts.map((s) => s.location_id)).toEqual(['loc1', 'loc2'])
    expect(out.crossStudioChecked).toBe(true)
    expect(out.error).toBeNull()
  })

  it('reads names and employment type only: never a pay column', async () => {
    const db = mockDb()
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.profiles[0].select).toBe('id, full_name, employment_type')
    expect(db.log.assignments.map((q) => q.select).join(' ')).not.toMatch(/rate|salary|contracted|overtime|compensation/)
    expect(out.people.get('emp')).toEqual({ full_name: 'Sam Demo', employment_type: 'fte' })
  })

  it('never reads a contractor\'s shifts, and reads nothing at all when nobody is an employee', async () => {
    const db = mockDb()
    await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments[0].profileIds).toEqual(['emp'])
    const onlyCon = mockDb()
    const out = await loadWorkingTimeShifts(onlyCon, { ...ARGS, profileIds: ['con'] })
    expect(onlyCon.log.assignments).toHaveLength(0)
    expect(out).toMatchObject({ shifts: [], crossStudioChecked: true, error: null })
  })

  it('reads the window it is given, and flattens to the shape the rules read, live rows only', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00', { end_time_override: '22:30:00' }),
      row('a2', 'emp', 'loc1', '2026-09-23', '06:30:00', '08:00:00', { status: 'cancelled' }),
    ] })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments[0].gte).toEqual(['shift_blocks.block_date', '2026-09-20'])
    expect(db.log.assignments[0].lte).toEqual(['shift_blocks.block_date', '2026-09-28'])
    expect(out.shifts).toEqual([{
      profile_id: 'emp', block_id: 'b-a1', block_date: '2026-09-22', location_id: 'loc2', location_name: 'Studio South',
      name: 'Class', status: 'scheduled', start_time_override: null, end_time_override: '22:30:00',
      start_time: '20:00:00', end_time: '22:00:00', shift_templates: { start_time: '20:00:00', end_time: '22:00:00' },
    }])
  })

  it('pages past the 1,000-row cap, ordered by id', async () => {
    const assignments = Array.from({ length: 1001 }, (_, i) =>
      row(`a${String(i).padStart(4, '0')}`, 'emp', 'loc1', '2026-09-22', '09:00:00', '10:00:00'))
    const db = mockDb({ assignments })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments).toHaveLength(2)
    expect(db.log.assignments[0].orders).toEqual(['id'])
    expect(out.shifts).toHaveLength(1001)
  })

  it('unreadable sibling studios narrow the read to this studio and say the check is incomplete', async () => {
    siblingLocationIds.mockResolvedValue({ ids: [], error: { message: 'siblings unreadable' } })
    const db = mockDb({ assignments: [row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00')] })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(db.log.assignments[0].locIds).toEqual(['loc1'])
    expect(out.shifts).toHaveLength(1)
    expect(out.crossStudioChecked).toBe(false)
    expect(out.error).toBeNull()
  })

  it('a failed read is an error with NO shifts, never an empty all-clear', async () => {
    for (const fail of [{ failPeople: true }, { failAssignments: true }]) {
      const out = await loadWorkingTimeShifts(mockDb({ ...fail, assignments: [row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00')] }), ARGS)
      expect(out.shifts).toEqual([])
      expect(out.error).toMatchObject({ message: expect.stringMatching(/unreadable/) })
    }
  })

  it('never throws', async () => {
    const out = await loadWorkingTimeShifts(mockDb({ throwOn: 'shift_assignments' }), ARGS)
    expect(out).toMatchObject({ shifts: [], crossStudioChecked: false, error: { message: 'shift_assignments: client exploded' } })
  })

  it('nobody to check: no reads at all', async () => {
    const db = mockDb()
    const out = await loadWorkingTimeShifts(db, { ...ARGS, profileIds: [] })
    expect(siblingLocationIds).not.toHaveBeenCalled()
    expect(db.log.profiles).toHaveLength(0)
    expect(out).toMatchObject({ shifts: [], crossStudioChecked: true, error: null })
  })
})

// OWNER REVIEW (WORKTIME.1 review notes 3 and 4). Each choice is a named
// constant whose default is pinned here, and the other reading is pinned too,
// so flipping either is a one-line change with its behaviour already tested.
describe('loadWorkingTimeShifts — owner-review switches', () => {
  it('defaults: drafts at the other studio count, and approved leave is not subtracted (no leave read at all)', async () => {
    expect([COUNT_UNPUBLISHED_ELSEWHERE, SUBTRACT_APPROVED_LEAVE]).toEqual([true, false])
    const db = mockDb({
      assignments: [
        row('a1', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00', {}, 'draft'),
        row('a2', 'emp', 'loc2', '2026-09-23', '20:00:00', '22:00:00', {}, null),
      ],
      leave: [{ id: 'l1', profile_id: 'emp', start_date: '2026-09-22', end_date: '2026-09-23' }],
    })
    const out = await loadWorkingTimeShifts(db, ARGS)
    expect(out.shifts.map((s) => s.block_id)).toEqual(['b-a1', 'b-a2'])
    expect(db.log.leave).toHaveLength(0)
  })

  it('countUnpublishedElsewhere: false drops an unpublished shift at ANOTHER studio only', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00', {}, 'draft'),
      row('a2', 'emp', 'loc2', '2026-09-23', '20:00:00', '22:00:00', {}, null),
      row('a3', 'emp', 'loc2', '2026-09-24', '20:00:00', '22:00:00', {}, 'published'),
      row('a4', 'emp', 'loc1', '2026-09-25', '06:30:00', '08:00:00', {}, 'draft'), // here: the roster being built
    ] })
    const out = await loadWorkingTimeShifts(db, { ...ARGS, countUnpublishedElsewhere: false })
    expect(out.shifts.map((s) => s.block_id)).toEqual(['b-a3', 'b-a4'])
  })

  it('subtractApprovedLeave: true reads approved leave for the employees and drops the shifts it covers', async () => {
    const db = mockDb({
      assignments: [
        row('a1', 'emp', 'loc1', '2026-09-21', '09:00:00', '12:00:00'),
        row('a2', 'emp', 'loc2', '2026-09-22', '09:00:00', '12:00:00'),
        row('a3', 'emp', 'loc1', '2026-09-24', '09:00:00', '12:00:00'),
      ],
      leave: [{ id: 'l1', profile_id: 'emp', start_date: '2026-09-22', end_date: '2026-09-23' }],
    })
    const out = await loadWorkingTimeShifts(db, { ...ARGS, subtractApprovedLeave: true })
    expect(out.shifts.map((s) => s.block_id)).toEqual(['b-a1', 'b-a3'])
    expect(db.log.leave).toHaveLength(1)
    expect(db.log.leave[0]).toMatchObject({
      select: 'id, profile_id, start_date, end_date',
      ids: ['emp'],
      eqs: [['status', 'approved']],
      lte: ['start_date', '2026-09-28'],
      gte: ['end_date', '2026-09-20'],
    })
  })

  it('subtractApprovedLeave: an unreadable leave read is an error, never an all-clear', async () => {
    const out = await loadWorkingTimeShifts(
      mockDb({ failLeave: true, assignments: [row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00')] }),
      { ...ARGS, subtractApprovedLeave: true },
    )
    expect(out).toMatchObject({ shifts: [], error: { message: 'leave unreadable' } })
  })
})

// CANDIDATES.1 — the assignments loop, extracted so the candidate list reads
// the same rows (same boundary, same shape) for EVERYONE, contractors too.
describe('readOrgShiftRows (CANDIDATES.1)', () => {
  const SCOPE = { locationId: 'loc1', scopeIds: ['loc1', 'loc2'], from: '2026-09-20', to: '2026-09-28' }

  it('reads whoever it is given, contractors included, and reads no profiles', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'con', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a2', 'emp', 'loc2', '2026-09-22', '20:00:00', '22:00:00'),
    ] })
    const out = await readOrgShiftRows(db, { ...SCOPE, profileIds: ['emp', 'con'] })
    expect(db.log.profiles).toHaveLength(0)
    expect(db.log.assignments[0].profileIds).toEqual(['emp', 'con'])
    expect(out.error).toBeNull()
    expect(out.shifts.map((s) => [s.profile_id, s.location_id])).toEqual([['con', 'loc1'], ['emp', 'loc2']])
  })

  it('keeps this studio first in the scope and drops a row from outside it even if it comes back', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a9', 'emp', 'loc9', '2026-09-23', '06:00:00', '08:00:00'),
    ] })
    const out = await readOrgShiftRows(db, { ...SCOPE, scopeIds: ['loc2', 'loc1'], profileIds: ['emp'] })
    expect(db.log.assignments[0].locIds).toEqual(['loc1', 'loc2'])
    expect(out.shifts.map((s) => s.block_id)).toEqual(['b-a1'])
  })

  it('skip() drops the rows it names; cancelled rows never come back', async () => {
    const db = mockDb({ assignments: [
      row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00'),
      row('a2', 'emp', 'loc1', '2026-09-23', '09:00:00', '12:00:00'),
      row('a3', 'emp', 'loc1', '2026-09-24', '09:00:00', '12:00:00', { status: 'cancelled' }),
    ] })
    const out = await readOrgShiftRows(db, { ...SCOPE, profileIds: ['emp'], skip: (_id, date) => date === '2026-09-22' })
    expect(out.shifts.map((s) => s.block_date)).toEqual(['2026-09-23'])
  })

  it('pages past 1,000 rows, ordered by id', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => row(`a${String(i).padStart(4, '0')}`, 'emp', 'loc1', '2026-09-22', '09:00:00', '10:00:00'))
    const db = mockDb({ assignments: many })
    const out = await readOrgShiftRows(db, { ...SCOPE, profileIds: ['emp'] })
    expect(db.log.assignments).toHaveLength(2)
    expect(db.log.assignments[0].orders).toEqual(['id'])
    expect(out.shifts).toHaveLength(1001)
  })

  it('nobody to read: no query at all', async () => {
    const db = mockDb()
    const out = await readOrgShiftRows(db, { ...SCOPE, profileIds: [] })
    expect(db.log.assignments).toHaveLength(0)
    expect(out).toEqual({ shifts: [], error: null })
  })

  it('a failed or throwing read is an error with NO shifts, never an empty all-clear', async () => {
    const failed = await readOrgShiftRows(mockDb({ failAssignments: true, assignments: [row('a1', 'emp', 'loc1', '2026-09-22', '09:00:00', '12:00:00')] }), { ...SCOPE, profileIds: ['emp'] })
    expect(failed).toEqual({ shifts: [], error: { message: 'assignments unreadable' } })
    const thrown = await readOrgShiftRows(mockDb({ throwOn: 'shift_assignments' }), { ...SCOPE, profileIds: ['emp'] })
    expect(thrown).toEqual({ shifts: [], error: { message: 'shift_assignments: client exploded' } })
  })
})
