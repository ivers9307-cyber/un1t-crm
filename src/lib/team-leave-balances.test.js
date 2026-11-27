// LEAVEBAL.1 — the pure row builder behind GET /api/schedule/allowances/team.
import { describe, it, expect } from 'vitest'
import { buildTeamLeaveRows } from './team-leave-balances'

const staff = [
  { id: 'b', full_name: 'Bob', employment_type: 'fte' },
  { id: 'a', full_name: 'Ann', employment_type: 'fte' },
  { id: 'c', full_name: 'Cat', employment_type: 'contractor' },
  { id: 'n', full_name: null, employment_type: null },
]

describe('buildTeamLeaveRows', () => {
  it('stored row: remaining = total + carried − used; pending reported beside it, not subtracted', () => {
    const [ann] = buildTeamLeaveRows({
      staff: [staff[1]],
      allowances: [{ profile_id: 'a', total_days: '20', carried_over: '2.5', used_days: '4' }],
      entitlements: [],
      pending: [{ profile_id: 'a', total_days: 1.5 }, { profile_id: 'a', total_days: 2 }],
      lieuRows: [],
    })
    expect(ann.holiday).toEqual({ stored: true, total_days: 20, carried_over: 2.5, used_days: 4, remaining: 18.5 })
    expect(ann.pending_days).toBe(3.5)
    expect(ann.lieu).toEqual({ credited_hours: 0, taken_hours: 0, balance_hours: 0 })
  })

  it('no row: the contract entitlement, or the 20-day default when none is set', () => {
    const rows = buildTeamLeaveRows({ staff: staff.slice(0, 2), allowances: [], entitlements: [{ profile_id: 'b', annual_leave_entitlement: 23 }], pending: [], lieuRows: [] })
    expect(rows.find((r) => r.profile_id === 'b').holiday.total_days).toBe(23)
    expect(rows.find((r) => r.profile_id === 'a').holiday).toEqual({ stored: false, total_days: 20, carried_over: 0, used_days: 0, remaining: 20 })
  })

  it('LEAVEPRORATA.1 — no row: pro-rated for the year by start and leaving date', () => {
    const rows = buildTeamLeaveRows({
      staff: staff.slice(0, 2),
      allowances: [],
      entitlements: [
        { profile_id: 'b', annual_leave_entitlement: 20, employment_start_date: '2026-09-01', employment_end_date: null },
        { profile_id: 'a', annual_leave_entitlement: 20, employment_start_date: '2024-01-01', employment_end_date: null },
      ],
      pending: [],
      lieuRows: [],
      year: 2026,
    })
    expect(rows.find((r) => r.profile_id === 'b').holiday.total_days).toBe(6.5)
    expect(rows.find((r) => r.profile_id === 'a').holiday.total_days).toBe(20)
  })

  it('contractors are not applicable for both holiday and lieu, even with stray rows', () => {
    const [cat] = buildTeamLeaveRows({
      staff: [staff[2]],
      allowances: [{ profile_id: 'c', total_days: 20, carried_over: 0, used_days: 0 }],
      entitlements: [], pending: [], lieuRows: [{ profile_id: 'c', source: 'manual', hours: 5 }],
    })
    expect(cat).toMatchObject({ not_applicable: true, holiday: null, pending_days: null, lieu: null })
  })

  it('an unreadable part (null) is unknown, never 0', () => {
    const rows = buildTeamLeaveRows({ staff: [staff[1]], allowances: null, entitlements: [], pending: null, lieuRows: null })
    expect(rows[0]).toMatchObject({ holiday: null, pending_days: null, lieu: null })
  })

  it('entitlements unreadable: a stored row still shows; a person with no row is unknown', () => {
    const rows = buildTeamLeaveRows({
      staff: staff.slice(0, 2),
      allowances: [{ profile_id: 'a', total_days: 20, carried_over: 0, used_days: 1 }],
      entitlements: null, pending: [], lieuRows: [],
    })
    expect(rows.find((r) => r.profile_id === 'a').holiday.remaining).toBe(19)
    expect(rows.find((r) => r.profile_id === 'b').holiday).toBeNull()
  })

  it('lieu is hours, grouped per person, never folded into days', () => {
    const rows = buildTeamLeaveRows({
      staff: staff.slice(0, 2), allowances: [], entitlements: [], pending: [],
      lieuRows: [
        { profile_id: 'a', source: 'sunday_worked', hours: '10.67' },
        { profile_id: 'a', source: 'taken', hours: '-4' },
        { profile_id: 'b', source: 'manual', hours: '3' },
      ],
    })
    const ann = rows.find((r) => r.profile_id === 'a')
    expect(ann.lieu.balance_hours).toBe(6.67)
    expect(ann.holiday.remaining).toBe(20)
    expect(rows.find((r) => r.profile_id === 'b').lieu.balance_hours).toBe(3)
  })

  it('sorts by name and names an unnamed profile', () => {
    const rows = buildTeamLeaveRows({ staff, allowances: [], entitlements: [], pending: [], lieuRows: [] })
    expect(rows.map((r) => r.full_name)).toEqual(['Ann', 'Bob', 'Cat', 'Unnamed'])
  })
})
