// Tests for the achievements engine. Pure detectors get exhaustive
// coverage; the DB-touching orchestrator gets one happy-path + one
// error-path smoke test with a mocked Supabase chain.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import {
  buildAchievementContext,
  runDetectors,
  detectFirstEvent,
  detectStreak,
  detectAggregateThreshold,
  detectSessionProperty,
  detectClassTypeCount,
  detectLocationVisit,
  runDetectionForSession,
} from './achievements.js'

const MS_DAY = 24 * 3600 * 1000

function s(over = {}) {
  return {
    id: over.id || 's-' + Math.random().toString(36).slice(2, 8),
    contact_id: 'c-1',
    location_id: 'loc-A',
    event_type_id: 'evt-RIDE',
    started_at: '2026-05-08T18:00:00Z',
    ended_at:   '2026-05-08T18:45:00Z',
    effort_points: 100,
    zones_seconds: { 1: 60, 2: 600, 3: 1200, 4: 600, 5: 0 },
    ...over,
  }
}

// ── buildAchievementContext ────────────────────────────────────

describe('buildAchievementContext', () => {
  it('flags isFirstSession when history is empty', () => {
    const ctx = buildAchievementContext(s(), [])
    expect(ctx.isFirstSession).toBe(true)
  })

  it('aggregates effort_points across history + this session', () => {
    const ctx = buildAchievementContext(
      s({ effort_points: 100 }),
      [s({ effort_points: 80 }), s({ effort_points: 120 })],
    )
    expect(ctx.aggregateAllTime('effort_points')).toBe(300)
  })

  it('priorMaxByEventType excludes this session', () => {
    const ctx = buildAchievementContext(
      s({ event_type_id: 'evt-RIDE', effort_points: 200 }),
      [
        s({ event_type_id: 'evt-RIDE', effort_points: 80 }),
        s({ event_type_id: 'evt-HIIT', effort_points: 150 }),
      ],
    )
    expect(ctx.priorMaxByEventType.get('evt-RIDE')).toBe(80)
    expect(ctx.priorMaxByEventType.get('evt-HIIT')).toBe(150)
  })

  it('uniqDayMs dedups same-day sessions and orders newest-first', () => {
    const t = (iso) => ({ started_at: iso, ended_at: iso, zones_seconds: {} })
    const session = s({ started_at: '2026-05-08T18:00:00Z', ended_at: '2026-05-08T18:45:00Z' })
    const history = [
      t('2026-05-06T10:00:00Z'),
      t('2026-05-07T10:00:00Z'),
      t('2026-05-07T18:00:00Z'), // same day duplicate
    ]
    const ctx = buildAchievementContext(session, history)
    expect(ctx.uniqDayMs.length).toBe(3) // May 6, 7, 8
    expect(ctx.uniqDayMs[0]).toBeGreaterThan(ctx.uniqDayMs[1])
  })
})

// ── detectFirstEvent ───────────────────────────────────────────

describe('detectFirstEvent', () => {
  it('event=session unlocks only on first session', () => {
    expect(detectFirstEvent(buildAchievementContext(s(), []), { event: 'session' }).unlocked).toBe(true)
    expect(detectFirstEvent(buildAchievementContext(s(), [s()]), { event: 'session' }).unlocked).toBe(false)
  })

  it('event=z5_minute requires Z5 in this session AND no prior Z5', () => {
    const ctx = buildAchievementContext(
      s({ zones_seconds: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 90 } }),
      [s({ zones_seconds: { 1: 60, 2: 60, 3: 0, 4: 0, 5: 0 } })],
    )
    expect(detectFirstEvent(ctx, { event: 'z5_minute' }).unlocked).toBe(true)
  })

  it('event=z5_minute does not unlock if a prior session had Z5', () => {
    const ctx = buildAchievementContext(
      s({ zones_seconds: { 5: 200 } }),
      [s({ zones_seconds: { 5: 60 } })],
    )
    expect(detectFirstEvent(ctx, { event: 'z5_minute' }).unlocked).toBe(false)
  })

  it('event=z5_minute does not unlock if this session is < 60s in Z5', () => {
    const ctx = buildAchievementContext(s({ zones_seconds: { 5: 30 } }), [])
    expect(detectFirstEvent(ctx, { event: 'z5_minute' }).unlocked).toBe(false)
  })

  it('event=class_type unlocks when this is the first of that type', () => {
    const ctx = buildAchievementContext(
      s({ event_type_id: 'evt-NEW' }),
      [s({ event_type_id: 'evt-OTHER' })],
    )
    expect(detectFirstEvent(ctx, { event: 'class_type', event_type_id: 'evt-NEW' }).unlocked).toBe(true)
  })

  it('event=location_visit unlocks first session at the configured location', () => {
    const ctx = buildAchievementContext(
      s({ location_id: 'loc-NEW' }),
      [s({ location_id: 'loc-OTHER' })],
    )
    expect(detectFirstEvent(ctx, { event: 'location_visit', location_id: 'loc-NEW' }).unlocked).toBe(true)
  })
})

// ── detectStreak ──────────────────────────────────────────────

describe('detectStreak', () => {
  // Helper: build an array of 1-per-day sessions ending today (UTC).
  function dailyStreak(days, endIso = '2026-05-08T18:00:00Z') {
    const end = new Date(endIso).getTime()
    const arr = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end - i * MS_DAY)
      arr.push({
        started_at: d.toISOString(),
        ended_at: d.toISOString(),
        zones_seconds: { 2: 600 },
      })
    }
    return arr
  }

  it('unlocks 7-day streak when 7 consecutive days ending today', () => {
    const all = dailyStreak(7)
    const this_ = all[all.length - 1]
    const history = all.slice(0, -1)
    const ctx = buildAchievementContext(this_, history)
    expect(detectStreak(ctx, { days: 7 }).unlocked).toBe(true)
  })

  it('does NOT unlock 7-day if there is a 1-day gap mid-streak', () => {
    const days = dailyStreak(7)
    days.splice(3, 1) // remove day 4
    const this_ = days[days.length - 1]
    const ctx = buildAchievementContext(this_, days.slice(0, -1))
    expect(detectStreak(ctx, { days: 7 }).unlocked).toBe(false)
  })

  it('does NOT unlock 7-day if member was on a streak before but took days off', () => {
    // 7 consecutive days May 1-7, big gap, single session today (May 13).
    // The session today is day 1 of a new streak, not the 8th day of the old one.
    const old = dailyStreak(7, '2026-05-07T18:00:00Z')
    const this_ = {
      started_at: '2026-05-13T18:00:00Z',
      ended_at:   '2026-05-13T18:45:00Z',
      zones_seconds: { 2: 600 },
    }
    const ctx = buildAchievementContext(this_, old)
    expect(detectStreak(ctx, { days: 7 }).unlocked).toBe(false)
  })

  it('unlocks 3-day streak with a smaller window', () => {
    const all = dailyStreak(3)
    const this_ = all[all.length - 1]
    const ctx = buildAchievementContext(this_, all.slice(0, -1))
    expect(detectStreak(ctx, { days: 3 }).unlocked).toBe(true)
  })

  it('returns metadata.days = the actual streak length', () => {
    const all = dailyStreak(10)
    const this_ = all[all.length - 1]
    const ctx = buildAchievementContext(this_, all.slice(0, -1))
    const out = detectStreak(ctx, { days: 7 })
    expect(out.unlocked).toBe(true)
    expect(out.metadata.days).toBeGreaterThanOrEqual(7)
  })
})

// ── detectAggregateThreshold ──────────────────────────────────

describe('detectAggregateThreshold', () => {
  it('classes/all_time unlocks at exactly threshold', () => {
    const history = Array.from({ length: 4 }, () => s())
    const ctx = buildAchievementContext(s(), history) // total = 5
    expect(detectAggregateThreshold(ctx, {
      field: 'classes', period: 'all_time', threshold: 5,
    }).unlocked).toBe(true)
  })

  it('classes/all_time does not unlock below threshold', () => {
    const history = Array.from({ length: 3 }, () => s())
    const ctx = buildAchievementContext(s(), history) // total = 4
    expect(detectAggregateThreshold(ctx, {
      field: 'classes', period: 'all_time', threshold: 5,
    }).unlocked).toBe(false)
  })

  it('z3plus_minutes/all_time sums z3+z4+z5', () => {
    const ctx = buildAchievementContext(
      s({ zones_seconds: { 3: 600, 4: 600, 5: 600 } }), // = 30 min
      [s({ zones_seconds: { 3: 600, 4: 600, 5: 600 } })], // = 30 min
    )
    expect(detectAggregateThreshold(ctx, {
      field: 'z3plus_minutes', period: 'all_time', threshold: 60,
    }).unlocked).toBe(true)
  })

  it('effort_points/week respects ISO week boundary', () => {
    // 2026-05-08 is a Friday. ISO week starts Monday 2026-05-04.
    const inWeek = s({
      started_at: '2026-05-06T10:00:00Z', ended_at: '2026-05-06T10:45:00Z', effort_points: 200,
    })
    const before = s({
      started_at: '2026-05-03T10:00:00Z', ended_at: '2026-05-03T10:45:00Z', effort_points: 500,
    })
    const this_ = s({ started_at: '2026-05-08T18:00:00Z', ended_at: '2026-05-08T18:45:00Z', effort_points: 200 })
    const ctx = buildAchievementContext(this_, [before, inWeek])
    // In-week total = 200 + 200 = 400. Before-week 500 excluded.
    expect(detectAggregateThreshold(ctx, {
      field: 'effort_points', period: 'week', threshold: 500,
    }).unlocked).toBe(false)
    expect(detectAggregateThreshold(ctx, {
      field: 'effort_points', period: 'week', threshold: 400,
    }).unlocked).toBe(true)
  })
})

// ── detectSessionProperty ─────────────────────────────────────

describe('detectSessionProperty', () => {
  it('all_zones_present requires all 5 zones non-zero', () => {
    expect(detectSessionProperty(
      buildAchievementContext(s({ zones_seconds: { 1: 60, 2: 60, 3: 60, 4: 60, 5: 60 } }), []),
      { predicate: 'all_zones_present' },
    ).unlocked).toBe(true)
    expect(detectSessionProperty(
      buildAchievementContext(s({ zones_seconds: { 1: 60, 2: 60, 3: 60, 4: 60, 5: 0 } }), []),
      { predicate: 'all_zones_present' },
    ).unlocked).toBe(false)
  })

  it('sustained_z5 with default threshold 60s', () => {
    expect(detectSessionProperty(
      buildAchievementContext(s({ zones_seconds: { 5: 90 } }), []),
      { predicate: 'sustained_z5' },
    ).unlocked).toBe(true)
    expect(detectSessionProperty(
      buildAchievementContext(s({ zones_seconds: { 5: 30 } }), []),
      { predicate: 'sustained_z5' },
    ).unlocked).toBe(false)
  })

  it('sustained_z5 honours custom threshold', () => {
    expect(detectSessionProperty(
      buildAchievementContext(s({ zones_seconds: { 5: 200 } }), []),
      { predicate: 'sustained_z5', threshold: 300 },
    ).unlocked).toBe(false)
    expect(detectSessionProperty(
      buildAchievementContext(s({ zones_seconds: { 5: 320 } }), []),
      { predicate: 'sustained_z5', threshold: 300 },
    ).unlocked).toBe(true)
  })

  it('new_personal_record fires when this session beats prior max for the class type', () => {
    const ctx = buildAchievementContext(
      s({ event_type_id: 'evt-RIDE', effort_points: 250 }),
      [
        s({ event_type_id: 'evt-RIDE', effort_points: 200 }),
        s({ event_type_id: 'evt-HIIT', effort_points: 999 }), // different type, ignored
      ],
    )
    expect(detectSessionProperty(ctx, { predicate: 'new_personal_record' }).unlocked).toBe(true)
  })

  it('new_personal_record does NOT fire on a tie', () => {
    const ctx = buildAchievementContext(
      s({ event_type_id: 'evt-RIDE', effort_points: 200 }),
      [s({ event_type_id: 'evt-RIDE', effort_points: 200 })],
    )
    expect(detectSessionProperty(ctx, { predicate: 'new_personal_record' }).unlocked).toBe(false)
  })

  it('new_personal_record requires an event_type_id on the session', () => {
    const ctx = buildAchievementContext(
      s({ event_type_id: null, effort_points: 999 }),
      [],
    )
    expect(detectSessionProperty(ctx, { predicate: 'new_personal_record' }).unlocked).toBe(false)
  })
})

// ── detectClassTypeCount ──────────────────────────────────────

describe('detectClassTypeCount', () => {
  it('unlocks when N total sessions of the type, with this session of that type', () => {
    const ctx = buildAchievementContext(
      s({ event_type_id: 'evt-RIDE' }),
      [
        s({ event_type_id: 'evt-RIDE' }),
        s({ event_type_id: 'evt-RIDE' }),
        s({ event_type_id: 'evt-HIIT' }),
      ],
    )
    expect(detectClassTypeCount(ctx, { event_type_id: 'evt-RIDE', count: 3 }).unlocked).toBe(true)
  })

  it('does NOT fire when this session is a different class type', () => {
    const ctx = buildAchievementContext(
      s({ event_type_id: 'evt-HIIT' }),
      [
        s({ event_type_id: 'evt-RIDE' }),
        s({ event_type_id: 'evt-RIDE' }),
        s({ event_type_id: 'evt-RIDE' }),
      ],
    )
    expect(detectClassTypeCount(ctx, { event_type_id: 'evt-RIDE', count: 3 }).unlocked).toBe(false)
  })
})

// ── detectLocationVisit ───────────────────────────────────────

describe('detectLocationVisit', () => {
  it('unlocks when distinct locations >= count', () => {
    const ctx = buildAchievementContext(
      s({ location_id: 'loc-C' }),
      [s({ location_id: 'loc-A' }), s({ location_id: 'loc-B' })],
    )
    expect(detectLocationVisit(ctx, { location_count: 3 }).unlocked).toBe(true)
  })

  it('does not unlock with the same location repeated', () => {
    const ctx = buildAchievementContext(
      s({ location_id: 'loc-A' }),
      [s({ location_id: 'loc-A' }), s({ location_id: 'loc-A' })],
    )
    expect(detectLocationVisit(ctx, { location_count: 2 }).unlocked).toBe(false)
  })
})

// ── runDetectors dispatcher ───────────────────────────────────

describe('runDetectors', () => {
  it('skips inactive rules', () => {
    const ctx = buildAchievementContext(s(), [])
    const fired = runDetectors([
      { id: 'r1', slug: 'first_session', rule_type: 'first_event', rule_config: { event: 'session' }, is_active: false },
    ], ctx)
    expect(fired).toEqual([])
  })

  it('unknown rule_type is ignored, not crashing', () => {
    const ctx = buildAchievementContext(s(), [])
    const fired = runDetectors([
      { id: 'r1', slug: 'mystery', rule_type: 'time_travel', rule_config: {}, is_active: true },
    ], ctx)
    expect(fired).toEqual([])
  })

  it('returns the firing rules with metadata attached', () => {
    const ctx = buildAchievementContext(s(), [])
    const fired = runDetectors([
      { id: 'r1', slug: 'first_session', rule_type: 'first_event', rule_config: { event: 'session' }, is_active: true },
    ], ctx)
    expect(fired.length).toBe(1)
    expect(fired[0].rule.id).toBe('r1')
  })
})

// ── runDetectionForSession (DB orchestrator) ──────────────────

describe('runDetectionForSession', () => {
  function mockDb({ session, history = [], rules = [], earned = [], insertError = null }) {
    return {
      from: vi.fn((table) => {
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: session, error: session ? null : { message: 'not found' } })),
                not:    vi.fn(() => ({
                  neq: vi.fn(() => ({ gte: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: history, error: null })) })) })),
                })),
              })),
            })),
          }
        }
        if (table === 'achievement_rules') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: rules, error: null })),
            })),
          }
        }
        if (table === 'contact_achievements') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: earned, error: null })),
            })),
            upsert: vi.fn(() => ({
              select: vi.fn(() => Promise.resolve({ data: [], error: insertError })),
            })),
          }
        }
        throw new Error(`unexpected table ${table}`)
      }),
    }
  }

  it('happy path: inserts unlocked rows and returns slugs', async () => {
    const session = {
      id: 'sess-1', contact_id: 'c-1', location_id: 'loc-A', booking_id: null,
      started_at: '2026-05-08T18:00:00Z', ended_at: '2026-05-08T18:45:00Z',
      effort_points: 100, zones_seconds: { 5: 0 },
      bookings: { event_type_id: 'evt-RIDE' },
    }
    const rules = [
      { id: 'r-first', slug: 'first_session', rule_type: 'first_event', rule_config: { event: 'session' }, is_active: true },
    ]
    const db = mockDb({ session, history: [], rules, earned: [] })
    const out = await runDetectionForSession(db, 'sess-1')
    expect(out.ok).toBe(true)
    expect(out.unlocked.map((u) => u.slug)).toEqual(['first_session'])
  })

  it('error path: returns ok:false when session not found', async () => {
    const db = mockDb({ session: null })
    const out = await runDetectionForSession(db, 'missing')
    expect(out.ok).toBe(false)
  })

  it('skips rules already earned (no double-grant)', async () => {
    const session = {
      id: 'sess-1', contact_id: 'c-1', location_id: 'loc-A', booking_id: null,
      started_at: '2026-05-08T18:00:00Z', ended_at: '2026-05-08T18:45:00Z',
      effort_points: 100, zones_seconds: {},
      bookings: { event_type_id: 'evt-RIDE' },
    }
    const rules = [
      { id: 'r-first', slug: 'first_session', rule_type: 'first_event', rule_config: { event: 'session' }, is_active: true },
    ]
    const db = mockDb({ session, history: [], rules, earned: [{ rule_id: 'r-first' }] })
    const out = await runDetectionForSession(db, 'sess-1')
    expect(out.ok).toBe(true)
    expect(out.unlocked).toEqual([])
  })
})
