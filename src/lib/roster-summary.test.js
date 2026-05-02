// Roster v2 phase 4 — summary helper tests.

import { describe, it, expect } from 'vitest'
import { summarizeWeek, summarizeMonth } from './roster-summary'

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
      const d = new Date(weekStart); d.setDate(d.getDate() + i)
      const iso = d.toISOString().slice(0, 10)
      blocks.push(block({ id: `b${i}`, date: iso, start: '09:00', end: '14:00', coaches: ['sarah'] }))
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
      ...Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart); d.setDate(d.getDate() + i)
        return block({ id: `a${i}`, date: d.toISOString().slice(0, 10), start: '09:00', end: '14:00', coaches: ['a'] })
      }),
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
