import { describe, it, expect } from 'vitest'
import { summariseEnrolmentRun, describeNextStep } from './run-history.js'

describe('summariseEnrolmentRun', () => {
  it('active → in-progress with 1-based step of N', () => {
    expect(summariseEnrolmentRun({ status: 'active', current_step_order: 1 }, 4))
      .toEqual({ state: 'active', stepLabel: 'Step 2 of 4', outcome: 'In progress' })
  })
  it('active with no step count → omits "of N"', () => {
    expect(summariseEnrolmentRun({ status: 'active', current_step_order: 0 }, 0))
      .toEqual({ state: 'active', stepLabel: 'Step 1', outcome: 'In progress' })
  })
  it('completed', () => {
    expect(summariseEnrolmentRun({ status: 'completed', current_step_order: 3 }, 4).outcome).toBe('Completed')
  })
  it('exited with goal_met → friendly', () => {
    expect(summariseEnrolmentRun({ status: 'exited', exit_reason: 'goal_met' }, 4).outcome).toBe('Exited: goal met')
  })
  it('exited with an arbitrary reason → passes it through', () => {
    expect(summariseEnrolmentRun({ status: 'exited', exit_reason: 'Contact deleted' }, 4).outcome).toBe('Exited: Contact deleted')
  })
  it('exited with no reason', () => {
    expect(summariseEnrolmentRun({ status: 'exited' }, 4).outcome).toBe('Exited')
  })
  it('paused surfaces last_error when present', () => {
    expect(summariseEnrolmentRun({ status: 'paused', last_error: 'Bad email' }, 4).outcome).toBe('Paused: Bad email')
  })
  it('unknown status falls back', () => {
    expect(summariseEnrolmentRun({ status: 'weird' }, 4).outcome).toBe('weird')
  })
})

describe('describeNextStep', () => {
  const now = Date.parse('2026-07-02T19:52:00Z')

  it('overdue when next_step_at is in the past (runs on the next tick)', () => {
    expect(describeNextStep('2026-07-02T19:50:54Z', now)).toEqual({ overdue: true, minutes: 0 })
  })

  it('reports minutes until a future step, rounding up', () => {
    expect(describeNextStep('2026-07-02T19:52:30Z', now)).toEqual({ overdue: false, minutes: 1 })
    expect(describeNextStep('2026-07-02T20:52:00Z', now)).toEqual({ overdue: false, minutes: 60 })
  })

  it('null for missing or garbage timestamps', () => {
    expect(describeNextStep(null, now)).toBeNull()
    expect(describeNextStep(undefined, now)).toBeNull()
    expect(describeNextStep('not-a-date', now)).toBeNull()
  })
})
