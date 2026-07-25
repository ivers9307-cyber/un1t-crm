// AGENT-HANDOFF-SLA.1 — unit tests for the pure escalation decisions.
import { describe, it, expect } from 'vitest'
import {
  classifyHandoffBreach,
  resolveHandoffSlaMinutes,
  shouldSweepLocation,
  waitingLabel,
  HANDOFF_SLA_DEFAULT_MINUTES,
} from './handoff-sla'

const H = 3600_000
const NOW = Date.parse('2026-07-03T16:00:00Z')

describe('resolveHandoffSlaMinutes', () => {
  it('defaults to 60', () => {
    expect(resolveHandoffSlaMinutes(null)).toBe(HANDOFF_SLA_DEFAULT_MINUTES)
    expect(resolveHandoffSlaMinutes({})).toBe(60)
    expect(resolveHandoffSlaMinutes({ handoff_sla_minutes: 'nonsense' })).toBe(60)
  })
  it('honours an operator override and 0-disables', () => {
    expect(resolveHandoffSlaMinutes({ handoff_sla_minutes: 30 })).toBe(30)
    expect(resolveHandoffSlaMinutes({ handoff_sla_minutes: 0 })).toBe(0)
    expect(resolveHandoffSlaMinutes({ handoff_sla_minutes: -5 })).toBe(0)
  })
})

// MIA-REVIEW.3 (3.7) — the sweep used to skip the whole location the moment
// the agent was disabled, abandoning customers already waiting for a human.
// enabled=false is the documented panic response to an agent incident, i.e.
// exactly when a pile of unattended handoffs is most likely.
describe('shouldSweepLocation', () => {
  it('keeps sweeping when the agent has been DISABLED (customers are still waiting)', () => {
    expect(shouldSweepLocation({ enabled: false, test_mode: false }))
      .toEqual({ sweep: true, slaMinutes: 60 })
  })
  it('sweeps a live agent and honours the per-location SLA', () => {
    expect(shouldSweepLocation({ enabled: true, handoff_sla_minutes: 30 }))
      .toEqual({ sweep: true, slaMinutes: 30 })
  })
  it('skips a location that never configured the agent', () => {
    expect(shouldSweepLocation(null)).toEqual({ sweep: false, reason: 'no_agent_config' })
  })
  it('skips when the operator disabled the SLA itself', () => {
    expect(shouldSweepLocation({ enabled: true, handoff_sla_minutes: 0 }))
      .toEqual({ sweep: false, reason: 'sla_disabled' })
  })
})

describe('classifyHandoffBreach', () => {
  const base = { handedOffAtMs: NOW - 2 * H, escalatedAt: null, resolvedAtMs: null, humanRepliedAtMs: null, nowMs: NOW }

  it('breaches when past SLA with no human touch (the Kevin case)', () => {
    expect(classifyHandoffBreach(base)).toEqual({ breach: true })
  })
  it('stays quiet inside the SLA window', () => {
    expect(classifyHandoffBreach({ ...base, handedOffAtMs: NOW - 30 * 60_000 }).breach).toBe(false)
  })
  it('stays quiet once escalated (one alert per handoff)', () => {
    expect(classifyHandoffBreach({ ...base, escalatedAt: new Date(NOW - H).toISOString() }).reason).toBe('already_escalated')
  })
  it('stays quiet when a human replied after the handoff', () => {
    expect(classifyHandoffBreach({ ...base, humanRepliedAtMs: NOW - H }).reason).toBe('human_replied')
  })
  it('a manual-takeover message written in the same request as the stamp counts as the human reply', () => {
    // operator send recorded 2s BEFORE the takeover stamp (write-order skew)
    expect(classifyHandoffBreach({ ...base, humanRepliedAtMs: base.handedOffAtMs - 2_000 }).reason).toBe('human_replied')
  })
  it('a human reply from BEFORE the handoff does not count', () => {
    expect(classifyHandoffBreach({ ...base, humanRepliedAtMs: base.handedOffAtMs - H }).breach).toBe(true)
  })
  it('stays quiet when the thread was resolved after the handoff', () => {
    expect(classifyHandoffBreach({ ...base, resolvedAtMs: NOW - H }).reason).toBe('resolved')
  })
  it('a resolve from before the handoff does not count', () => {
    expect(classifyHandoffBreach({ ...base, resolvedAtMs: base.handedOffAtMs - H }).breach).toBe(true)
  })
  it('sla 0 disables entirely', () => {
    expect(classifyHandoffBreach({ ...base, slaMinutes: 0 }).reason).toBe('sla_disabled')
  })
})

describe('waitingLabel', () => {
  it('formats minutes and hours', () => {
    expect(waitingLabel(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(waitingLabel(NOW - 90 * 60_000, NOW)).toBe('1h 30m')
    expect(waitingLabel(NOW - 2 * H, NOW)).toBe('2h')
    expect(waitingLabel(NOW - 23 * H, NOW)).toBe('23h')
  })
})
