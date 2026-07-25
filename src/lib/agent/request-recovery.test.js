// MIA-REVIEW.3 (3.18) — pure helpers for recovering an approval whose
// execution crashed between the atomic claim and the Glofox call finishing.
import { describe, it, expect } from 'vitest'
import {
  EXECUTION_STALE_MS,
  stuckExecutionStartedAt,
  isStuckExecuting,
  executingMarker,
  finishedMarker,
} from './request-recovery'

const NOW = Date.parse('2026-07-25T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

function row(overrides = {}) {
  return {
    status: 'approved',
    kind: 'class_booking',
    details: { execution: { stage: 'executing', started_at: ago(EXECUTION_STALE_MS + 1000) } },
    ...overrides,
  }
}

describe('stuckExecutionStartedAt', () => {
  it('flags an executing approval that went stale', () => {
    expect(stuckExecutionStartedAt(row(), NOW)).toBe(ago(EXECUTION_STALE_MS + 1000))
    expect(isStuckExecuting(row(), NOW)).toBe(true)
  })
  it('leaves a live (slow but running) execution alone', () => {
    const live = row({ details: { execution: { stage: 'executing', started_at: ago(30_000) } } })
    expect(stuckExecutionStartedAt(live, NOW)).toBeNull()
  })
  it('ignores a finished execution', () => {
    const done = row({ details: { execution: { stage: 'done', started_at: ago(2 * EXECUTION_STALE_MS) } } })
    expect(stuckExecutionStartedAt(done, NOW)).toBeNull()
  })
  it('ignores non-executing kinds (pause/cancellation are actioned by hand)', () => {
    expect(stuckExecutionStartedAt(row({ kind: 'pause' }), NOW)).toBeNull()
    expect(stuckExecutionStartedAt(row({ kind: 'membership_purchase' }), NOW)).toBeNull()
  })
  it('ignores rows that are not sitting at approved', () => {
    expect(stuckExecutionStartedAt(row({ status: 'pending' }), NOW)).toBeNull()
    expect(stuckExecutionStartedAt(row({ status: 'actioned' }), NOW)).toBeNull()
    expect(stuckExecutionStartedAt(row({ status: 'failed' }), NOW)).toBeNull()
  })
  it('is safe on rows with no marker at all (everything before this change)', () => {
    expect(stuckExecutionStartedAt({ status: 'approved', kind: 'class_booking', details: {} }, NOW)).toBeNull()
    expect(stuckExecutionStartedAt({ status: 'approved', kind: 'class_booking' }, NOW)).toBeNull()
    expect(stuckExecutionStartedAt(null, NOW)).toBeNull()
  })
  it('ignores an unparseable timestamp rather than treating it as stale', () => {
    const bad = row({ details: { execution: { stage: 'executing', started_at: 'not-a-date' } } })
    expect(stuckExecutionStartedAt(bad, NOW)).toBeNull()
  })
})

describe('execution markers', () => {
  it('stamps the intent without losing the existing details', () => {
    const d = executingMarker({ class_name: 'ARENA' }, { startedAt: '2026-07-25T12:00:00.000Z', by: 'user-1' })
    expect(d).toEqual({
      class_name: 'ARENA',
      execution: { stage: 'executing', started_at: '2026-07-25T12:00:00.000Z', by: 'user-1' },
    })
  })
  it('closes the marker out and keeps the result payload', () => {
    const started = executingMarker({ class_name: 'ARENA' }, { startedAt: '2026-07-25T12:00:00.000Z' })
    const withResult = { ...started, result: { ok: true } }
    const done = finishedMarker(withResult, { finishedAt: '2026-07-25T12:00:03.000Z' })
    expect(done.result).toEqual({ ok: true })
    expect(done.execution).toMatchObject({ stage: 'done', finished_at: '2026-07-25T12:00:03.000Z' })
    expect(isStuckExecuting({ status: 'approved', kind: 'class_booking', details: done }, NOW)).toBe(false)
  })
  it('finishedMarker is a no-op when nothing was stamped', () => {
    expect(finishedMarker({ a: 1 }, { finishedAt: 'x' })).toEqual({ a: 1 })
  })
})
