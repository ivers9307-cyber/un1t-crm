// SEQEXIT.1 — exit reasons are operator-facing now.
//
// The panel rendered the raw enum with underscores swapped for spaces
// ("left audience (3)"), which reads as a typo rather than an outcome.
// The stats route groups by exit_reason, so the labelling belongs here,
// in the one place that renders them — not in a second parallel map.

import { describe, it, expect } from 'vitest'
import { exitReasonLabel } from './AutomationPerformance.jsx'

describe('exitReasonLabel', () => {
  it('names the SEQEXIT.1 audience exit in operator language', () => {
    expect(exitReasonLabel('left_audience')).toBe('No longer matched the audience')
  })

  it('labels the reasons the engine already writes', () => {
    expect(exitReasonLabel('goal_met')).toBe('Goal met')
    expect(exitReasonLabel('unsubscribed')).toBe('Unsubscribed')
    expect(exitReasonLabel('unspecified')).toBe('Unspecified')
  })

  it('falls back to the de-underscored reason for anything unmapped', () => {
    // Historical/free-text reasons must still render legibly — exit_reason
    // is free text, so the map can never be exhaustive.
    expect(exitReasonLabel('some_future_reason')).toBe('some future reason')
    expect(exitReasonLabel('')).toBe('Unspecified')
    expect(exitReasonLabel(null)).toBe('Unspecified')
  })
})
