// Roster v2 phase 4 — summary helper tests.

import { describe, it, expect } from 'vitest'
import { summarizeWeek, summarizeMonth, leaveHoursInWeek } from './roster-summary'
import { formatDate } from './roster'

// Local-TZ-safe ISO date for a day offset from `base`. Mirrors how
// production code (formatDate in ./roster) reads the LOCAL date
// components — needed because the test's weekStart is parsed as
// local time (no Z suffix), but a naive `d.toISOString().slice(0,10)`
// formats in UTC and drifts a day off in timezones east of UTC
// (e.g. Europe/Dublin in BST). Keeping the test internally consistent
// with the production formatter is the right shape.
function isoDay(base, offset = 0) {
  const d = new Date(base)
  d.setDate(d.getDate() + offset)
  return formatDate(d)
}

// Helper: build a block with N assigned coaches.
function block({ id, date, start, end, max = 15, coaches = [] }) {
  return {
    id,
    location_id: 'loc1',
    block_date: date,
    start_time: start,
    end_time: end,
    max_coaches: max,
    shift_templates: { start_time: start, end_time: end },
    shift_assignments: coaches.map((profile_id, i) => ({
      id: `a-${id}-${i}`,
      profile_id,
      profiles: { id: profile_id, full_name: profile_id },
    })),
  }
}

const fteSarah = {
  id: 'sarah', full_name: 'Sarah FTE', active: true,
  employment_type: 'fte',
  contracted_hours_per_week: 30,
  annual_salary: 39000,        // implicit rate = 39000/52/30 = 25/h
  hourly_rate: null,
  overtime_rate: null,
}

const contractorDan = {
  id: 'dan', full_name: 'Dan Contractor', active: true,
  employment_type: 'contractor',
  contracted_hours_per_week: null,
  hourly_rate: 35,
}

const contractorEve = {
  id: 'eve', full_name: 'Eve Contractor', active: true,
  employment_type: 'contractor',
  contracted_hours_per_week: null,
  hourly_rate: 40,
}

const incompleteFte = {
  id: 'incomplete-f', full_name: 'Incomplete FTE', active: true,
  employment_type: 'fte',
  contracted_hours_per_week: 0,
  annual_salary: null,
  hourly_rate: null,
}

const incompleteContractor = {
  id: 'incomplete-c', full_name: 'Incomplete Contractor', active: true,
  employment_type: 'contractor',
  contracted_hours_per_week: null,
  hourly_rate: null,
}

describe('summarizeWeek', () => {
  // 2026-05-04 is a Monday.
  const weekStart = new Date('2026-05-04T00:00:00')

  it('returns zero rows for an empty week', () => {
    const r = summarizeWeek({ blocks: [], staff: [fteSarah, contractorDan], weekStart })
    expect(r.fte).toEqual([])
    expect(r.contractorWeekCostEur).toBe(0)
    expect(r.blockCount).toBe(0)
    expect(r.unstaffedCount).toBe(0)
  })

  it('rolls up FTE allocated hours (3 × 1h Mon/Wed/Fri = 3h underused vs 30h)', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:30', end: '10:30', coaches: ['sarah'] }),
      block({ id: 'b2', date: '2026-05-06', start: '09:30', end: '10:30', coaches: ['sarah'] }),
      block({ id: 'b3', date: '2026-05-08', start: '09:30', end: '10:30', coaches: ['sarah'] }),
    ]
    const r = summarizeWeek({ blocks, staff: [fteSarah], weekStart })
    expect(r.fte).toHaveLength(1)
    expect(r.fte[0]).toMatchObject({
      profile_id: 'sarah',
      allocated_hours: 3,
      contracted_hours: 30,
      utilisation_pct: 10,
      status: 'underused',
    })
  })

  it('flags FTE over-hours as overtime', () => {
    const blocks = []
    // 35 hours of work: 7 days × 5h.
    for (let i = 0; i < 7; i++) {
      blocks.push(block({ id: `b${i}`, date: isoDay(weekStart, i), start: '09:00', end: '14:00', coaches: ['sarah'] }))
    }
    const r = summarizeWeek({ blocks, staff: [fteSarah], weekStart })
    expect(r.fte[0].status).toBe('overtime')
    expect(r.fte[0].allocated_hours).toBe(35)
    expect(r.fte[0].utilisation_pct).toBe(117) // 35/30
  })

  it('treats >= 95% allocation as on_target', () => {
    // 29h vs 30h contracted = 96.7%
    const blocks = []
    blocks.push(block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '14:00', coaches: ['sarah'] })) // 5h
    blocks.push(block({ id: 'b2', date: '2026-05-05', start: '09:00', end: '15:00', coaches: ['sarah'] })) // 6h
    blocks.push(block({ id: 'b3', date: '2026-05-06', start: '09:00', end: '15:00', coaches: ['sarah'] })) // 6h
    blocks.push(block({ id: 'b4', date: '2026-05-07', start: '09:00', end: '15:00', coaches: ['sarah'] })) // 6h
    blocks.push(block({ id: 'b5', date: '2026-05-08', start: '09:00', end: '15:00', coaches: ['sarah'] })) // 6h
    const r = summarizeWeek({ blocks, staff: [fteSarah], weekStart })
    expect(r.fte[0].allocated_hours).toBe(29)
    expect(r.fte[0].status).toBe('on_target')
  })

  it('costs contractor hours × rate, FTE excluded from the euro total', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan', 'sarah'] }),
      block({ id: 'b2', date: '2026-05-05', start: '17:00', end: '20:00', coaches: ['eve'] }),
    ]
    const r = summarizeWeek({ blocks, staff: [fteSarah, contractorDan, contractorEve], weekStart })
    // dan 2h × 35 = 70, eve 3h × 40 = 120 → 190
    expect(r.contractorWeekCostEur).toBe(190)
    // FTE Sarah is in the FTE list, not the contractor cost
    expect(r.fte.find(f => f.profile_id === 'sarah')?.allocated_hours).toBe(2)
  })

  it('counts unstaffed future blocks (today included), not past', () => {
    const today = new Date('2026-05-06T12:00:00') // Wed
    const blocks = [
      block({ id: 'b-past',   date: '2026-05-04', start: '09:00', end: '10:00' }), // empty + past — IGNORED
      block({ id: 'b-today',  date: '2026-05-06', start: '09:00', end: '10:00' }), // empty + today — counted
      block({ id: 'b-future', date: '2026-05-08', start: '09:00', end: '10:00' }), // empty + future — counted
      block({ id: 'b-staffed', date: '2026-05-07', start: '09:00', end: '10:00', coaches: ['dan'] }), // not empty
    ]
    const r = summarizeWeek({ blocks, staff: [contractorDan], weekStart, today })
    expect(r.blockCount).toBe(4)
    expect(r.unstaffedCount).toBe(2)
  })

  it('lists names of staff with incomplete pay data when they are rostered', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '10:00', coaches: ['incomplete-f', 'incomplete-c'] }),
    ]
    const r = summarizeWeek({ blocks, staff: [incompleteFte, incompleteContractor], weekStart })
    expect(r.incompleteProfileNames).toContain('Incomplete FTE')
    expect(r.incompleteProfileNames).toContain('Incomplete Contractor')
  })

  it('sorts FTE rows: overtime first, then no_contract, underused, on_target', () => {
    const fteAlpha = { ...fteSarah, id: 'a', full_name: 'Alpha' }
    const fteBeta = { ...fteSarah, id: 'b', full_name: 'Beta' }
    const fteGamma = { ...fteSarah, id: 'c', full_name: 'Gamma', contracted_hours_per_week: 0, annual_salary: null }
    const blocks = [
      // Alpha: 35h overtime
      ...Array.from({ length: 7 }, (_, i) =>
        block({ id: `a${i}`, date: isoDay(weekStart, i), start: '09:00', end: '14:00', coaches: ['a'] })
      ),
      // Beta: 5h underused
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '14:00', coaches: ['b'] }),
      // Gamma: 5h no_contract (contracted=0)
      block({ id: 'g1', date: '2026-05-04', start: '09:00', end: '14:00', coaches: ['c'] }),
    ]
    const r = summarizeWeek({ blocks, staff: [fteAlpha, fteBeta, fteGamma], weekStart })
    const names = r.fte.map(f => f.full_name)
    expect(names[0]).toBe('Alpha') // overtime
    expect(names[1]).toBe('Gamma') // no_contract
    expect(names[2]).toBe('Beta')  // underused
  })
})

describe('leaveHoursInWeek (phase 6)', () => {
  // 2026-05-04 = Monday. Mon-Fri only count.
  const weekStart = new Date('2026-05-04T00:00:00')
  const fte30 = 30 // contracted hours per week → 6h/day

  it('returns 0 when contracted hours is 0', () => {
    expect(leaveHoursInWeek({
      timeOff: [{ profile_id: 's1', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-08' }],
      profileId: 's1', weekStart, contractedHoursPerWeek: 0,
    })).toBe(0)
  })

  it('returns 0 with no time-off rows', () => {
    expect(leaveHoursInWeek({ timeOff: [], profileId: 's1', weekStart, contractedHoursPerWeek: fte30 })).toBe(0)
  })

  it('subtracts 6h × 3 weekdays = 18h for Mon-Wed approved holiday', () => {
    const r = leaveHoursInWeek({
      timeOff: [{ profile_id: 's1', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-06' }],
      profileId: 's1', weekStart, contractedHoursPerWeek: fte30,
    })
    expect(r).toBe(18)
  })

  it('caps the deduction at the contracted hours (full-week leave)', () => {
    const r = leaveHoursInWeek({
      timeOff: [{ profile_id: 's1', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-10' }],
      profileId: 's1', weekStart, contractedHoursPerWeek: fte30,
    })
    expect(r).toBe(30)
  })

  it('weekend leave (Sat-Sun) deducts nothing', () => {
    const r = leaveHoursInWeek({
      timeOff: [{ profile_id: 's1', status: 'approved', start_date: '2026-05-09', end_date: '2026-05-10' }],
      profileId: 's1', weekStart, contractedHoursPerWeek: fte30,
    })
    expect(r).toBe(0)
  })

  it('ignores other profiles', () => {
    const r = leaveHoursInWeek({
      timeOff: [{ profile_id: 'someone-else', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-08' }],
      profileId: 's1', weekStart, contractedHoursPerWeek: fte30,
    })
    expect(r).toBe(0)
  })

  it('ignores pending or rejected time-off', () => {
    const r = leaveHoursInWeek({
      timeOff: [
        { profile_id: 's1', status: 'pending',  start_date: '2026-05-04', end_date: '2026-05-08' },
        { profile_id: 's1', status: 'rejected', start_date: '2026-05-05', end_date: '2026-05-06' },
      ],
      profileId: 's1', weekStart, contractedHoursPerWeek: fte30,
    })
    expect(r).toBe(0)
  })

  it('handles a leave range that overlaps only partially with the week', () => {
    // Apr 30 (Thu) – May 5 (Tue): only Mon May 4 + Tue May 5 fall in the visible week
    const r = leaveHoursInWeek({
      timeOff: [{ profile_id: 's1', status: 'approved', start_date: '2026-04-30', end_date: '2026-05-05' }],
      profileId: 's1', weekStart, contractedHoursPerWeek: fte30,
    })
    expect(r).toBe(12) // 2 weekdays × 6h
  })
})

describe('summarizeWeek leave-awareness (phase 6)', () => {
  const weekStart = new Date('2026-05-04T00:00:00')
  const sarahFte = {
    id: 'sarah', full_name: 'Sarah FTE', active: true,
    employment_type: 'fte',
    contracted_hours_per_week: 30,
    annual_salary: 39000,
    hourly_rate: null,
  }

  function block({ id, date, start, end, coaches = [] }) {
    return {
      id,
      location_id: 'loc1',
      block_date: date,
      start_time: start,
      end_time: end,
      max_coaches: 15,
      shift_templates: { start_time: start, end_time: end },
      shift_assignments: coaches.map((p, i) => ({
        id: `a-${id}-${i}`, profile_id: p, profiles: { id: p, full_name: p },
      })),
    }
  }

  it('drops the denominator by leave hours (Sarah on holiday Mon-Wed)', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-07', start: '09:00', end: '15:00', coaches: ['sarah'] }), // Thu 6h
      block({ id: 'b2', date: '2026-05-08', start: '09:00', end: '15:00', coaches: ['sarah'] }), // Fri 6h
    ]
    const timeOff = [
      { profile_id: 'sarah', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-06' },
    ]
    const r = summarizeWeek({ blocks, staff: [sarahFte], weekStart, timeOff })
    const row = r.fte[0]
    expect(row.allocated_hours).toBe(12)
    expect(row.contracted_hours).toBe(30)
    expect(row.leave_hours).toBe(18)
    expect(row.effective_contracted_hours).toBe(12)
    expect(row.utilisation_pct).toBe(100)
    expect(row.status).toBe('on_target')
  })

  it('flags status=on_leave when rostered during full-week leave', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['sarah'] }),
    ]
    const timeOff = [
      { profile_id: 'sarah', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-10' },
    ]
    const r = summarizeWeek({ blocks, staff: [sarahFte], weekStart, timeOff })
    const row = r.fte[0]
    expect(row.status).toBe('on_leave')
    expect(row.leave_hours).toBe(30)
    expect(row.effective_contracted_hours).toBe(0)
  })

  it('on_leave rows sort to the top (loudest red)', () => {
    const sarahA = { ...sarahFte, id: 'a', full_name: 'Alpha' }
    const sarahB = { ...sarahFte, id: 'b', full_name: 'Beta' }
    const sarahC = { ...sarahFte, id: 'c', full_name: 'Charlie' }
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '12:00', coaches: ['a'] }), // Alpha — 3h, on full leave → on_leave
      // Beta — full overtime: 7 days × 5h = 35h
      ...Array.from({ length: 7 }, (_, i) =>
        block({ id: `bt${i}`, date: isoDay(weekStart, i), start: '09:00', end: '14:00', coaches: ['b'] })
      ),
      block({ id: 'c1', date: '2026-05-04', start: '09:00', end: '14:00', coaches: ['c'] }), // Charlie — 5h underused
    ]
    const timeOff = [
      { profile_id: 'a', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-10' },
    ]
    const r = summarizeWeek({ blocks, staff: [sarahA, sarahB, sarahC], weekStart, timeOff })
    expect(r.fte[0].full_name).toBe('Alpha')   // on_leave
    expect(r.fte[1].full_name).toBe('Beta')    // overtime
    expect(r.fte[2].full_name).toBe('Charlie') // underused
  })

  it('omitting timeOff entirely keeps phase-4 behaviour', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '14:00', coaches: ['sarah'] }), // 5h
    ]
    const r = summarizeWeek({ blocks, staff: [sarahFte], weekStart })
    const row = r.fte[0]
    expect(row.leave_hours).toBe(0)
    expect(row.effective_contracted_hours).toBe(30)
    expect(row.status).toBe('underused')
  })
})

describe('summarizeMonth', () => {
  const refMay = new Date('2026-05-15T12:00:00')

  it('zero spend with no blocks', () => {
    const r = summarizeMonth({ blocks: [], staff: [contractorDan], referenceDate: refMay, monthlyBudgetEur: 1000 })
    expect(r.contractorCostEur).toBe(0)
    expect(r.remainingEur).toBe(1000)
    expect(r.overBudget).toBe(false)
    expect(r.utilisationPct).toBe(0)
  })

  it('sums contractor cost across the month, ignores other months', () => {
    const blocks = [
      block({ id: 'in-may', date: '2026-05-04', start: '09:00', end: '12:00', coaches: ['dan'] }), // 3h × 35 = 105
      block({ id: 'in-may-2', date: '2026-05-30', start: '09:00', end: '11:00', coaches: ['dan'] }), // 2h × 35 = 70
      block({ id: 'in-jun', date: '2026-06-01', start: '09:00', end: '12:00', coaches: ['dan'] }), // ignored
      block({ id: 'in-apr', date: '2026-04-30', start: '09:00', end: '12:00', coaches: ['dan'] }), // ignored
    ]
    const r = summarizeMonth({ blocks, staff: [contractorDan], referenceDate: refMay, monthlyBudgetEur: 200 })
    expect(r.contractorCostEur).toBe(175)
    expect(r.remainingEur).toBe(25)
    expect(r.overBudget).toBe(false)
    expect(r.utilisationPct).toBe(88)
  })

  it('flags overBudget when spend > budget', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['dan'] }), // 4h × 35 = 140
    ]
    const r = summarizeMonth({ blocks, staff: [contractorDan], referenceDate: refMay, monthlyBudgetEur: 100 })
    expect(r.overBudget).toBe(true)
    expect(r.remainingEur).toBe(-40)
    expect(r.utilisationPct).toBe(140)
  })

  it('handles null budget — returns spend total only, no over/under', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '12:00', coaches: ['dan'] }),
    ]
    const r = summarizeMonth({ blocks, staff: [contractorDan], referenceDate: refMay, monthlyBudgetEur: null })
    expect(r.contractorCostEur).toBe(105)
    expect(r.monthlyBudgetEur).toBeNull()
    expect(r.remainingEur).toBeNull()
    expect(r.overBudget).toBe(false)
    expect(r.utilisationPct).toBeNull()
  })

  it('exposes FTE implicit cost separately (context, not budget input)', () => {
    const blocks = [
      block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['sarah'] }),
    ]
    const r = summarizeMonth({ blocks, staff: [fteSarah], referenceDate: refMay, monthlyBudgetEur: 1000 })
    // 4h × (39000/52/30 = €25/h) = €100
    expect(r.fteImplicitCostEur).toBe(100)
    // FTE doesn't hit the contractor budget
    expect(r.contractorCostEur).toBe(0)
  })
})
