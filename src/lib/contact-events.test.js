// Tests for src/lib/contact-events.js (mig 085).

import { describe, it, expect } from 'vitest'
import { TAG_RULES, EVENT_TYPES } from './contact-events'

function findRule(tag) {
  return TAG_RULES.find((r) => r.tag === tag)
}

function ev(type, opts = {}) {
  return {
    event_type: type,
    occurred_at: opts.at || new Date().toISOString(),
    source_type: opts.sourceType || null,
    source_id: opts.sourceId || null,
    event_metadata: opts.metadata || null,
  }
}

describe('TAG_RULES — race_completed', () => {
  const rule = findRule('race_completed')
  it('passes when at least one RACE_FINISHED', () => {
    expect(rule.evaluate([ev(EVENT_TYPES.RACE_FINISHED)])).toBe(true)
  })
  it('fails when no race events', () => {
    expect(rule.evaluate([])).toBe(false)
    expect(rule.evaluate([ev(EVENT_TYPES.RACE_REGISTERED)])).toBe(false)
  })
})

describe('TAG_RULES — repeat_racer', () => {
  const rule = findRule('repeat_racer')
  it('requires 2+ RACE_FINISHED', () => {
    expect(rule.evaluate([ev(EVENT_TYPES.RACE_FINISHED)])).toBe(false)
    expect(rule.evaluate([
      ev(EVENT_TYPES.RACE_FINISHED),
      ev(EVENT_TYPES.RACE_FINISHED),
    ])).toBe(true)
  })
})

describe('TAG_RULES — race_registered_no_payment', () => {
  const rule = findRule('race_registered_no_payment')
  it('passes when an order was abandoned and no completion follows', () => {
    expect(rule.evaluate([
      ev(EVENT_TYPES.ORDER_ABANDONED, { sourceType: 'race_registration' }),
    ])).toBe(true)
  })
  it('clears once a race-registration order completes', () => {
    expect(rule.evaluate([
      ev(EVENT_TYPES.ORDER_ABANDONED, { sourceType: 'race_registration' }),
      ev(EVENT_TYPES.ORDER_COMPLETED, { sourceType: 'race_registration' }),
    ])).toBe(false)
  })
  it('does not pass when only a CAR order was abandoned', () => {
    expect(rule.evaluate([
      ev(EVENT_TYPES.ORDER_ABANDONED, { sourceType: 'car_deposit' }),
    ])).toBe(false)
  })
})

describe('TAG_RULES — lapsed_payer', () => {
  const rule = findRule('lapsed_payer')
  it('passes when a failure has no completion within 7 days', () => {
    const failedAt = new Date('2026-04-01T00:00:00Z').toISOString()
    expect(rule.evaluate([
      ev(EVENT_TYPES.ORDER_FAILED, { at: failedAt }),
    ])).toBe(true)
  })
  it('clears when a same-week completion follows', () => {
    const failedAt = new Date('2026-04-01T00:00:00Z').toISOString()
    const completedAt = new Date('2026-04-04T00:00:00Z').toISOString()
    expect(rule.evaluate([
      ev(EVENT_TYPES.ORDER_FAILED, { at: failedAt }),
      ev(EVENT_TYPES.ORDER_COMPLETED, { at: completedAt }),
    ])).toBe(false)
  })
  it('still passes if completion is > 7 days later', () => {
    const failedAt = new Date('2026-04-01T00:00:00Z').toISOString()
    const completedAt = new Date('2026-04-15T00:00:00Z').toISOString()
    expect(rule.evaluate([
      ev(EVENT_TYPES.ORDER_FAILED, { at: failedAt }),
      ev(EVENT_TYPES.ORDER_COMPLETED, { at: completedAt }),
    ])).toBe(true)
  })
})

describe('TAG_RULES — race_starts_soon', () => {
  const rule = findRule('race_starts_soon')
  it('passes when 24h event was emitted and race has not started yet', () => {
    expect(rule.evaluate([
      ev(EVENT_TYPES.RACE_STARTS_IN_24H, { sourceId: 'reg-1' }),
    ])).toBe(true)
  })
  it('clears once the race starts', () => {
    expect(rule.evaluate([
      ev(EVENT_TYPES.RACE_STARTS_IN_24H, { sourceId: 'reg-1' }),
      ev(EVENT_TYPES.RACE_STARTED, { sourceId: 'reg-1' }),
    ])).toBe(false)
  })
})

describe('TAG_RULES — race_recently_completed', () => {
  const rule = findRule('race_recently_completed')
  it('passes for a race finished within the last 24h', () => {
    const recent = new Date(Date.now() - 60 * 60_000).toISOString() // 1h ago
    expect(rule.evaluate([
      ev(EVENT_TYPES.RACE_FINISHED, { at: recent }),
    ])).toBe(true)
  })
  it('expires after 24h', () => {
    const old = new Date(Date.now() - 25 * 3600_000).toISOString()
    expect(rule.evaluate([
      ev(EVENT_TYPES.RACE_FINISHED, { at: old }),
    ])).toBe(false)
  })
})

describe('EVENT_TYPES', () => {
  it('exposes the canonical event taxonomy as frozen object', () => {
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true)
    expect(EVENT_TYPES.ORDER_COMPLETED).toBe('order.completed')
    expect(EVENT_TYPES.RACE_FINISHED).toBe('race.finished')
  })
})
