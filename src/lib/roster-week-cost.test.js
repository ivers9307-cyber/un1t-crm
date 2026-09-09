// ROSTER-FIX.6c — the FTE overtime panel's arithmetic, moved off the browser.
//
// The point of the move is the SHAPE, not the sums: computeWeeklyCost is
// already pinned in payroll.test.js. What is pinned here is that annual_salary,
// hourly_rate and overtime_rate are read on the server and NONE of them, nor
// any figure derived from them in euro, appears in what the helper returns.

import { describe, it, expect, vi } from 'vitest'
import { computeWeeklyFteHours } from './roster-week-cost'

const LOC = 'loc-1'

// Mon 2026-05-04 .. Sun 2026-05-10.
const WEEK_START = '2026-05-04'

function tpl(start, end) {
  return { start_time: start, end_time: end }
}

function block({ id, date, start, end, coaches }) {
  return {
    id,
    location_id: LOC,
    template_id: 't1',
    block_date: date,
    start_time: start,
    end_time: end,
    shift_templates: tpl(start, end),
    shift_assignments: coaches.map((c, i) => (
      typeof c === 'string'
        ? { id: `${id}-${i}`, profile_id: c, status: 'scheduled' }
        : { id: `${id}-${i}`, status: 'scheduled', ...c }
    )),
  }
}

const SARAH = {
  id: 'sarah', full_name: 'Sarah FTE', active: true, employment_type: 'fte',
  contracted_hours_per_week: 10, annual_salary: 39000, hourly_rate: null, overtime_rate: 45,
}
const CON = {
  id: 'con', full_name: 'Con Tractor', active: true, employment_type: 'contractor',
  contracted_hours_per_week: null, annual_salary: null, hourly_rate: 30, overtime_rate: null,
}
const NO_CONTRACT = {
  id: 'nc', full_name: 'No Contract', active: true, employment_type: 'fte',
  contracted_hours_per_week: 0, annual_salary: 39000, hourly_rate: null, overtime_rate: null,
}

/**
 * Minimal thenable-shaped supabase double. `tables` maps a table name to the
 * rows its select resolves with.
 */
function buildDb(tables, errors = {}) {
  return {
    from(table) {
      const q = {}
      for (const op of ['eq', 'in', 'gte', 'lte', 'order', 'select']) q[op] = () => q
      q.then = (res, rej) => Promise.resolve({
        data: tables[table] || [],
        error: errors[table] || null,
      }).then(res, rej)
      return q
    },
  }
}

function callWith({ blocks = [], staff = [], links, weekStart = WEEK_START, errors } = {}) {
  const db = buildDb({
    shift_blocks: blocks,
    profiles: staff,
    profile_locations: links || staff.map((s) => ({ profile_id: s.id })),
  }, errors)
  return computeWeeklyFteHours({ db, locationId: LOC, weekStart })
}

describe('computeWeeklyFteHours', () => {
  it('reports hours, contracted hours and overtime for an FTE over their contract', async () => {
    const res = await callWith({
      staff: [SARAH],
      blocks: [
        block({ id: 'b1', date: '2026-05-04', start: '09:00:00', end: '15:00:00', coaches: ['sarah'] }),
        block({ id: 'b2', date: '2026-05-05', start: '09:00:00', end: '17:00:00', coaches: ['sarah'] }),
      ],
    })
    expect(res.weekStartIso).toBe('2026-05-04')
    expect(res.weekEndIso).toBe('2026-05-10')
    expect(res.coaches).toEqual([{
      profile_id: 'sarah',
      full_name: 'Sarah FTE',
      allocated_hours: 14,
      contracted_hours: 10,
      overtime_hours: 4,
      status: 'overtime',
      over_threshold: true,
    }])
    expect(res.totals).toEqual({ coaches: 1, allocated_hours: 14, overtime_hours: 4, over_threshold: 1 })
  })

  // ROSTER-FIX.6c — the key set is the pin, not a grep for the fixture's
  // numbers. Bare numeric substrings ('45', '30') were doing the real work of
  // this test and could not keep doing it: they match any hours figure that
  // happens to contain those digits, so a legitimate 4.5h week would have
  // failed it, and any fixture edited to a different salary would have quietly
  // stopped testing anything. Pinning the exact keys the helper returns is what
  // actually forbids a rate: a new pay field cannot be added without failing
  // here. Same pin the route test carries, one layer down.
  it('NEVER returns a rate, a salary or a euro figure', async () => {
    const res = await callWith({
      staff: [SARAH, CON],
      blocks: [
        block({ id: 'b1', date: '2026-05-04', start: '09:00:00', end: '20:00:00', coaches: ['sarah', 'con'] }),
      ],
    })
    const wire = JSON.stringify(res).toLowerCase()
    for (const banned of ['rate', 'salary', 'cost', 'eur', 'annual', 'hourly']) {
      expect(wire).not.toContain(banned)
    }
    expect(Object.keys(res).sort()).toEqual(['coaches', 'totals', 'weekEndIso', 'weekStartIso'])
    expect(Object.keys(res.coaches[0]).sort()).toEqual([
      'allocated_hours', 'contracted_hours', 'full_name', 'over_threshold',
      'overtime_hours', 'profile_id', 'status',
    ])
    expect(Object.keys(res.totals).sort()).toEqual([
      'allocated_hours', 'coaches', 'over_threshold', 'overtime_hours',
    ])
  })

  it('is FTE-only: a contractor never appears, however many hours they work', async () => {
    const res = await callWith({
      staff: [CON],
      blocks: [block({ id: 'b1', date: '2026-05-04', start: '06:00:00', end: '20:00:00', coaches: ['con'] })],
    })
    expect(res.coaches).toEqual([])
  })

  it('drops an FTE with no contracted hours, and one who is rostered nothing', async () => {
    const res = await callWith({
      staff: [NO_CONTRACT, SARAH],
      blocks: [block({ id: 'b1', date: '2026-05-04', start: '09:00:00', end: '11:00:00', coaches: ['nc'] })],
    })
    expect(res.coaches).toEqual([])
  })

  it('reports an FTE under contract as on_target without an over_threshold flag', async () => {
    const res = await callWith({
      staff: [SARAH],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00:00', end: '13:00:00', coaches: ['sarah'] })],
    })
    expect(res.coaches[0]).toMatchObject({ allocated_hours: 4, overtime_hours: 0, over_threshold: false, status: 'under' })
    expect(res.totals.over_threshold).toBe(0)
  })

  it('counts exactly-at-contract as at_contract, which is what the panel surfaces', async () => {
    const res = await callWith({
      staff: [SARAH],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00:00', end: '19:00:00', coaches: ['sarah'] })],
    })
    expect(res.coaches[0]).toMatchObject({ allocated_hours: 10, overtime_hours: 0, over_threshold: false, status: 'at_contract' })
  })

  it('ignores a cancelled assignment', async () => {
    const res = await callWith({
      staff: [SARAH],
      blocks: [
        block({ id: 'b1', date: '2026-05-04', start: '09:00:00', end: '17:00:00', coaches: [{ profile_id: 'sarah', status: 'cancelled' }] }),
        block({ id: 'b2', date: '2026-05-05', start: '09:00:00', end: '12:00:00', coaches: ['sarah'] }),
      ],
    })
    expect(res.coaches[0].allocated_hours).toBe(3)
  })

  // ROSTER-HOURS.1 — the panel credits the window on the coach's OWN
  // assignment, so a coach cut back to part of a block is not shown a full
  // day. Same precedence as roster-publish.js and payroll's shiftHours.
  it('honours an assignment-level adjusted window', async () => {
    const res = await callWith({
      staff: [SARAH],
      blocks: [
        block({ id: 'b2', date: '2026-05-05', start: '09:00:00', end: '17:00:00', coaches: [{ profile_id: 'sarah', start_time_override: '09:00:00', end_time_override: '12:00:00' }] }),
      ],
    })
    expect(res.coaches[0].allocated_hours).toBe(3)
  })

  it('sorts the coaches over their contract first', async () => {
    const other = { ...SARAH, id: 'ann', full_name: 'Ann FTE' }
    const res = await callWith({
      staff: [SARAH, other],
      blocks: [
        block({ id: 'b1', date: '2026-05-04', start: '09:00:00', end: '11:00:00', coaches: ['sarah'] }),
        block({ id: 'b2', date: '2026-05-04', start: '09:00:00', end: '23:00:00', coaches: ['ann'] }),
      ],
    })
    expect(res.coaches.map((c) => c.profile_id)).toEqual(['ann', 'sarah'])
  })

  it('checks every error it gets back rather than reporting an empty week', async () => {
    await expect(callWith({ staff: [SARAH], errors: { shift_blocks: { message: 'boom' } } }))
      .rejects.toThrow('boom')
    await expect(callWith({ staff: [SARAH], errors: { profile_locations: { message: 'links down' } } }))
      .rejects.toThrow('links down')
    await expect(callWith({ staff: [SARAH], errors: { profiles: { message: 'profiles down' } } }))
      .rejects.toThrow('profiles down')
  })

  it('does not query profiles at all when the location has no staff linked', async () => {
    const db = buildDb({ shift_blocks: [], profile_locations: [] })
    const spy = vi.spyOn(db, 'from')
    const res = await computeWeeklyFteHours({ db, locationId: LOC, weekStart: WEEK_START })
    expect(res.coaches).toEqual([])
    expect(spy.mock.calls.map((c) => c[0])).not.toContain('profiles')
  })
})
