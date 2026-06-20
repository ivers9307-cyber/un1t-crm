import { describe, it, expect } from 'vitest'
import { GOAL_DEFS, GOAL_KINDS, computeProgress } from './goals.js'

describe('GOAL_DEFS contract', () => {
  it('has the four kinds with period + field', () => {
    expect(GOAL_KINDS).toEqual(['weekly_points', 'weekly_classes', 'monthly_points', 'monthly_classes'])
    expect(GOAL_DEFS.weekly_points).toMatchObject({ period: 'week', field: 'effort_points', unit: 'points' })
    expect(GOAL_DEFS.monthly_classes).toMatchObject({ period: 'month', field: 'classes', unit: 'classes' })
  })
})

describe('computeProgress', () => {
  const now = new Date('2026-06-20T12:00:00Z') // Saturday, ISO week 25
  it('sums effort_points within the week', () => {
    const sessions = [
      { started_at: '2026-06-16T10:00:00Z', effort_points: 200 },
      { started_at: '2026-06-20T10:00:00Z', effort_points: 150 },
      { started_at: '2026-06-14T10:00:00Z', effort_points: 999 },
    ]
    expect(computeProgress({ kind: 'weekly_points', target_value: 500 }, sessions, now).current).toBe(350)
  })
  it('counts classes within the month', () => {
    const sessions = [
      { started_at: '2026-06-02T10:00:00Z', effort_points: 100 },
      { started_at: '2026-06-19T10:00:00Z', effort_points: 100 },
      { started_at: '2026-05-30T10:00:00Z', effort_points: 100 },
    ]
    expect(computeProgress({ kind: 'monthly_classes', target_value: 16 }, sessions, now).current).toBe(2)
  })
})
