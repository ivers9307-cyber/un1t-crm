// Re-enrolment cooldown tests. The two regimes (legacy "any past
// enrolment blocks" vs cooldown "blocks only within N days of the
// most recent end") need to stay rock-solid because anyone who
// hits this path has either:
//   - completed a sequence and is being asked to re-enrol (typical:
//     a re-trigger fires a status_change handler shortly after a
//     completion), or
//   - manually re-enrolled by an operator who expects the cooldown
//     to kick in.
//
// A regression here either re-enrols people too eagerly (annoyance
// + spam-flag risk on transactional sends) or refuses re-enrolment
// silently (campaign goal misses). Pin both directions.

import { describe, it, expect } from 'vitest'
import { findBlockedByCooldown, planReenrolments } from './cooldown.js'

const DAY = 86_400_000

function row(contactId, endIso, status = 'completed') {
  return {
    contact_id: contactId,
    status,
    last_processed_at: endIso,
    created_at: endIso,
  }
}

describe('findBlockedByCooldown — legacy regime (no cooldown)', () => {
  it('returns an empty set for empty history', () => {
    expect(findBlockedByCooldown([], 0)).toEqual(new Set())
    expect(findBlockedByCooldown([], null)).toEqual(new Set())
    expect(findBlockedByCooldown([], undefined)).toEqual(new Set())
  })

  it('blocks every contact that has ANY terminal row when cooldown is 0', () => {
    const history = [row('a', '2026-04-01T00:00:00Z'), row('b', '2025-01-01T00:00:00Z')]
    expect(findBlockedByCooldown(history, 0)).toEqual(new Set(['a', 'b']))
  })

  it('blocks every contact when cooldown is null', () => {
    const history = [row('a', '2026-04-01T00:00:00Z')]
    expect(findBlockedByCooldown(history, null)).toEqual(new Set(['a']))
  })

  it('blocks every contact when cooldown is NaN / non-numeric', () => {
    const history = [row('a', '2026-04-01T00:00:00Z')]
    expect(findBlockedByCooldown(history, 'forever')).toEqual(new Set(['a']))
    expect(findBlockedByCooldown(history, NaN)).toEqual(new Set(['a']))
  })
})

describe('findBlockedByCooldown — cooldown regime (cooldownDays > 0)', () => {
  // Pin the clock so tests are deterministic.
  const NOW = new Date('2026-05-08T12:00:00Z').getTime()

  it('blocks contacts whose last terminal end is within the cooldown window', () => {
    // 5 days ago, cooldown 7 → blocked.
    const fiveDaysAgo = new Date(NOW - 5 * DAY).toISOString()
    expect(findBlockedByCooldown([row('a', fiveDaysAgo)], 7, NOW))
      .toEqual(new Set(['a']))
  })

  it('does NOT block contacts whose last terminal end is older than cooldown', () => {
    // 10 days ago, cooldown 7 → allowed.
    const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString()
    expect(findBlockedByCooldown([row('a', tenDaysAgo)], 7, NOW))
      .toEqual(new Set())
  })

  it('uses the MOST RECENT terminal end when a contact has multiple rows', () => {
    // A contact who completed once 30 days ago and exited 3 days ago:
    // the 3-days-ago wins, so they're blocked under a 7-day cooldown.
    const threeDaysAgo = new Date(NOW - 3 * DAY).toISOString()
    const thirtyDaysAgo = new Date(NOW - 30 * DAY).toISOString()
    const history = [
      row('a', thirtyDaysAgo, 'completed'),
      row('a', threeDaysAgo, 'exited'),
    ]
    expect(findBlockedByCooldown(history, 7, NOW)).toEqual(new Set(['a']))
  })

  it('falls back to created_at when last_processed_at is null', () => {
    const fiveDaysAgo = new Date(NOW - 5 * DAY).toISOString()
    const history = [{
      contact_id: 'a',
      status: 'completed',
      last_processed_at: null,
      created_at: fiveDaysAgo,
    }]
    expect(findBlockedByCooldown(history, 7, NOW)).toEqual(new Set(['a']))
  })

  it('skips rows with no end-time at all (defensive — shouldn\'t happen)', () => {
    const history = [{
      contact_id: 'a', status: 'completed',
      last_processed_at: null, created_at: null,
    }]
    expect(findBlockedByCooldown(history, 7, NOW)).toEqual(new Set())
  })

  it('skips rows missing contact_id (defensive)', () => {
    const history = [
      { contact_id: null, status: 'completed', last_processed_at: '2026-05-07', created_at: null },
      { status: 'completed', last_processed_at: '2026-05-07', created_at: null },
    ]
    expect(findBlockedByCooldown(history, 7, NOW)).toEqual(new Set())
  })

  it('blocks contact A but not contact B when A is in window and B is not', () => {
    const fiveDaysAgo = new Date(NOW - 5 * DAY).toISOString()
    const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString()
    expect(findBlockedByCooldown([
      row('a', fiveDaysAgo),
      row('b', tenDaysAgo),
    ], 7, NOW)).toEqual(new Set(['a']))
  })

  it('exactly at the boundary: end-time === now - cooldownDays → NOT blocked', () => {
    // The check is strict less-than (now - end < cooldownMs).
    const exactlySevenDaysAgo = new Date(NOW - 7 * DAY).toISOString()
    expect(findBlockedByCooldown([row('a', exactlySevenDaysAgo)], 7, NOW))
      .toEqual(new Set())
  })

  it('1 millisecond inside the window → blocked', () => {
    const justInside = new Date(NOW - 7 * DAY + 1).toISOString()
    expect(findBlockedByCooldown([row('a', justInside)], 7, NOW))
      .toEqual(new Set(['a']))
  })

  it('handles invalid date strings gracefully (does not block)', () => {
    const history = [row('a', 'not-a-date')]
    expect(findBlockedByCooldown(history, 7, NOW)).toEqual(new Set())
  })

  it('uses Date.now() when nowMs is omitted', () => {
    // Just sanity-check the default doesn't throw and returns a Set.
    const out = findBlockedByCooldown([row('a', '2020-01-01')], 7)
    expect(out).toBeInstanceOf(Set)
  })
})

describe('findBlockedByCooldown — input shape edge cases', () => {
  it('returns empty Set for non-array history', () => {
    expect(findBlockedByCooldown(null, 7)).toEqual(new Set())
    expect(findBlockedByCooldown(undefined, 7)).toEqual(new Set())
    expect(findBlockedByCooldown('nope', 7)).toEqual(new Set())
  })
})

// DUNNING.2 — re-activation planning. The full unique index on
// (sequence_id, contact_id) means a contact with a terminal row can never be
// INSERTED again; dunning callers re-activate that row instead. This decides,
// per contact, whether that is allowed right now.
describe('planReenrolments (DUNNING.2)', () => {
  const NOW = Date.parse('2026-08-23T12:00:00Z')
  const term = (contactId, endIso, over = {}) => ({
    id: `enr-${contactId}`, contact_id: contactId, status: 'completed',
    last_processed_at: endIso, created_at: endIso, source_ref: 'inv-old', ...over,
  })

  it('re-activates a terminal row outside the cooldown for a NEW source ref', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 20 * DAY).toISOString())], 14, 'inv-new', NOW)
    expect(plan.get('a')).toEqual({ decision: 'reactivate', row: expect.objectContaining({ id: 'enr-a' }) })
  })

  it('blocks a terminal row inside the cooldown', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 3 * DAY).toISOString())], 14, 'inv-new', NOW)
    expect(plan.get('a').decision).toBe('blocked')
  })

  it('never re-runs for the SAME source ref (Glofox re-sends PAST_DUE on every retry of one invoice)', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 20 * DAY).toISOString(), { source_ref: 'inv-same' })], 14, 'inv-same', NOW)
    expect(plan.get('a').decision).toBe('same_source')
  })

  it('a null source ref (operator click) always qualifies once the cooldown has passed', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 20 * DAY).toISOString())], 14, null, NOW)
    expect(plan.get('a').decision).toBe('reactivate')
  })

  it('no cooldown configured → blocked (legacy single-enrolment semantics are preserved)', () => {
    expect(planReenrolments([term('a', new Date(NOW - 400 * DAY).toISOString())], null, 'inv-new', NOW).get('a').decision).toBe('blocked')
    expect(planReenrolments([term('a', new Date(NOW - 400 * DAY).toISOString())], 0, 'inv-new', NOW).get('a').decision).toBe('blocked')
  })

  it('uses the most recent terminal row per contact', () => {
    const rows = [
      term('a', new Date(NOW - 40 * DAY).toISOString(), { id: 'enr-old' }),
      term('a', new Date(NOW - 2 * DAY).toISOString(), { id: 'enr-new' }),
    ]
    expect(planReenrolments(rows, 14, 'inv-new', NOW).get('a').decision).toBe('blocked')
    const rows2 = [
      term('a', new Date(NOW - 40 * DAY).toISOString(), { id: 'enr-old' }),
      term('a', new Date(NOW - 20 * DAY).toISOString(), { id: 'enr-new' }),
    ]
    expect(planReenrolments(rows2, 14, 'inv-new', NOW).get('a')).toMatchObject({ decision: 'reactivate', row: { id: 'enr-new' } })
  })

  it('tolerates empty / malformed input', () => {
    expect(planReenrolments([], 14, 'x', NOW).size).toBe(0)
    expect(planReenrolments(null, 14, 'x', NOW).size).toBe(0)
    expect(planReenrolments([{ contact_id: null }], 14, 'x', NOW).size).toBe(0)
  })
})
