// SEQGAPS.1 Task B — pure helpers for the operator's manual exit.
//
// Mirror of resume.test.js: the route CAS-es on status IN ('active','paused'),
// so a double-click or a cron race loses cleanly rather than double-writing.
// Zero rows updated is a BENIGN outcome (409), never a 500.

import { describe, it, expect } from 'vitest'
import { buildExitPatch, classifyExitOutcome, MANUAL_EXIT_REASON, EXITABLE_STATUSES } from './exit.js'

describe('buildExitPatch', () => {
  it('exits the enrolment and unschedules it', () => {
    const now = new Date('2026-08-09T12:00:00.000Z')
    expect(buildExitPatch(now)).toEqual({
      status: 'exited',
      exit_reason: 'manual_exit',
      next_step_at: null,
      last_processed_at: '2026-08-09T12:00:00.000Z',
    })
  })

  it('nulls next_step_at so the scheduler never picks it up again', () => {
    expect(buildExitPatch().next_step_at).toBeNull()
  })

  it('defaults to now', () => {
    const before = Date.now()
    const t = new Date(buildExitPatch().last_processed_at).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })

  it('uses the exit_reason the performance panel labels', () => {
    expect(MANUAL_EXIT_REASON).toBe('manual_exit')
  })
})

describe('EXITABLE_STATUSES', () => {
  it('is exactly the two live statuses — completed/exited rows are done', () => {
    expect(EXITABLE_STATUSES).toEqual(['active', 'paused'])
  })
})

describe('classifyExitOutcome', () => {
  it('200 when the CAS update landed', () => {
    expect(classifyExitOutcome({ updatedRow: { id: 'e1', status: 'exited' }, currentStatus: 'exited' }))
      .toEqual({ ok: true, status: 200 })
  })

  it('404 when the enrollment does not exist (or belongs to another sequence)', () => {
    expect(classifyExitOutcome({ updatedRow: null, currentStatus: null }))
      .toEqual({ ok: false, status: 404, error: 'Enrollment not found' })
  })

  it('409 — not 500 — on the second click, once it is already exited', () => {
    expect(classifyExitOutcome({ updatedRow: null, currentStatus: 'exited' }))
      .toEqual({ ok: false, status: 409, error: 'This contact has already left this sequence (exited)' })
  })

  it('409 when the enrolment completed before the operator clicked', () => {
    expect(classifyExitOutcome({ updatedRow: null, currentStatus: 'completed' }))
      .toEqual({ ok: false, status: 409, error: 'This contact has already left this sequence (completed)' })
  })
})
