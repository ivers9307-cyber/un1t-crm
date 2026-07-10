import { describe, it, expect } from 'vitest'
import { buildResumePatch, classifyResumeOutcome } from './resume.js'

describe('buildResumePatch', () => {
  it('produces the exact shape the scheduler expects (verified in prod 2026-07-10)', () => {
    const now = new Date('2026-07-10T12:00:00.000Z')
    expect(buildResumePatch(now)).toEqual({
      status: 'active',
      next_step_at: '2026-07-10T12:00:00.000Z',
      error_count: 0,
      last_error: null,
    })
  })

  it('defaults to now', () => {
    const before = Date.now()
    const patch = buildResumePatch()
    const t = new Date(patch.next_step_at).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })
})

describe('classifyResumeOutcome', () => {
  it('200 when the CAS update landed', () => {
    expect(classifyResumeOutcome({ updatedRow: { id: 'e1', status: 'active' }, currentStatus: 'active' }))
      .toEqual({ ok: true, status: 200 })
  })

  it('404 when the enrollment does not exist (or belongs to another sequence)', () => {
    expect(classifyResumeOutcome({ updatedRow: null, currentStatus: null }))
      .toEqual({ ok: false, status: 404, error: 'Enrollment not found' })
  })

  it('409 when the enrollment exists but is not paused (double-click safety)', () => {
    expect(classifyResumeOutcome({ updatedRow: null, currentStatus: 'active' }))
      .toEqual({ ok: false, status: 409, error: 'Enrollment is active, not paused — nothing to resume' })
    expect(classifyResumeOutcome({ updatedRow: null, currentStatus: 'completed' }))
      .toEqual({ ok: false, status: 409, error: 'Enrollment is completed, not paused — nothing to resume' })
  })
})
