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

// AGENT-RETRY.1 — a failed execution is retryable, not terminal.
import { isRetryableFailure, retryOffered, RETRY_OFFER_WINDOW_MS } from './request-recovery'

describe('isRetryableFailure', () => {
  it('accepts a failed executing-kind row', () => {
    expect(isRetryableFailure({ status: 'failed', kind: 'class_booking' })).toBe(true)
    expect(isRetryableFailure({ status: 'failed', kind: 'event_booking' })).toBe(true)
  })
  it('refuses non-failed statuses and non-executing kinds', () => {
    expect(isRetryableFailure({ status: 'actioned', kind: 'class_booking' })).toBe(false)
    expect(isRetryableFailure({ status: 'pending', kind: 'class_booking' })).toBe(false)
    expect(isRetryableFailure({ status: 'failed', kind: 'pause' })).toBe(false)
    // CANCEL-FORM.5 — cancellation is now conditionally executing (retryable); membership_purchase never executes.
    expect(isRetryableFailure({ status: 'failed', kind: 'membership_purchase' })).toBe(false)
    expect(isRetryableFailure(null)).toBe(false)
  })
})

describe('retryOffered — the UI gate is stricter than the route gate', () => {
  const failed = (overrides = {}) => ({ status: 'failed', kind: 'class_booking', details: {}, ...overrides })

  it('offers a failed booking whose class has not started', () => {
    expect(retryOffered(failed({ details: { starts_at: new Date(NOW + 3_600_000).toISOString() } }), NOW)).toBe(true)
  })
  it('withholds a failed booking whose class already started', () => {
    expect(retryOffered(failed({ details: { starts_at: ago(60_000) } }), NOW)).toBe(false)
  })
  it('without a start time, falls back to the decided-at recency window', () => {
    expect(retryOffered(failed({ kind: 'class_cancellation', decided_at: ago(3_600_000) }), NOW)).toBe(true)
    expect(retryOffered(failed({ kind: 'class_cancellation', decided_at: ago(RETRY_OFFER_WINDOW_MS + 1000) }), NOW)).toBe(false)
  })
  it('without a start time OR decided_at, offers nothing (no unbounded backlog)', () => {
    expect(retryOffered(failed({ kind: 'event_cancellation' }), NOW)).toBe(false)
  })
  it('never offers what isRetryableFailure refuses', () => {
    expect(retryOffered(failed({ kind: 'pause', decided_at: ago(1000) }), NOW)).toBe(false)
    expect(retryOffered(failed({ status: 'actioned', decided_at: ago(1000) }), NOW)).toBe(false)
  })
})

// CANCEL-FORM.5 — membership cancellation is a CONDITIONALLY executing kind:
// it runs the Glofox cancel only when the location's auto-cancel toggle is on.
// The recovery + retry machinery must cover it either way.
describe('CANCEL-FORM.5 — conditional executing kinds', () => {
  it('exposes cancellation as conditional and retryable, without adding it to EXECUTING_KINDS', async () => {
    const m = await import('./request-recovery.js')
    expect(m.EXECUTING_KINDS.has('cancellation')).toBe(false)
    expect(m.CONDITIONAL_EXECUTING_KINDS.has('cancellation')).toBe(true)
    expect(m.RETRYABLE_KINDS.has('cancellation')).toBe(true)
    expect(m.RETRYABLE_KINDS.has('class_booking')).toBe(true)
    expect(m.RETRYABLE_KINDS.has('pause')).toBe(false)
  })

  it('a failed cancellation execution is retryable and offered within the recency window', async () => {
    const { isRetryableFailure, retryOffered } = await import('./request-recovery.js')
    const row = { status: 'failed', kind: 'cancellation', details: { result: { message_code: 'NO_USER_MEMBERSHIP' } }, decided_at: new Date().toISOString() }
    expect(isRetryableFailure(row)).toBe(true)
    expect(retryOffered(row)).toBe(true)
    expect(isRetryableFailure({ ...row, kind: 'pause' })).toBe(false)
  })

  it('a cancellation stuck mid-execution is detected from the marker, not the kind list', async () => {
    const { stuckExecutionStartedAt, EXECUTION_STALE_MS } = await import('./request-recovery.js')
    const started = new Date(Date.now() - EXECUTION_STALE_MS - 1000).toISOString()
    const row = { status: 'approved', kind: 'cancellation', details: { execution: { stage: 'executing', started_at: started } } }
    expect(stuckExecutionStartedAt(row)).toBe(started)
    // No marker (toggle was off, nothing executed) → never "stuck".
    expect(stuckExecutionStartedAt({ status: 'approved', kind: 'cancellation', details: {} })).toBeNull()
  })
})
