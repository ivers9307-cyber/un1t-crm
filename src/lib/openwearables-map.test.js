// Tests for openwearables-map.js — pure mapper, no mocks needed.
//
// Fixtures are shaped like real OW data: Workout-Output + an array of
// TimeSeriesSample ({ timestamp, value, unit }).

import { describe, it, expect } from 'vitest'
import { mapAppleWorkoutToSession } from './openwearables-map.js'

// Fixed operator scoring config used across the suite (matches the
// SCORING_DEFAULTS shape from heart-rate.js: per-zone rate + flat no-HR value).
const scoring = { zonePoints: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }, participationPoints: 50 }
const maxHr = 200 // → 60%=120, 70%=140, 80%=160, 90%=180

// A workout that ran one minute (10:00:00 → 10:01:00 UTC).
const workoutWithHr = {
  id: 'wk_abc123',
  type: 'functional_strength_training',
  name: 'UN1T Stillorgan 10am',
  start_time: '2026-06-20T10:00:00Z',
  end_time: '2026-06-20T10:01:00Z',
  duration_seconds: 60,
  calories_kcal: 95,
  distance_meters: 0,
  avg_heart_rate_bpm: 150,
  max_heart_rate_bpm: 182,
  source: 'apple_watch',
}

// 61 one-Hz samples spanning a full minute (10:00:00 → 10:01:00). ~50s in
// Z3 (maxHr 200: 140 ≤ 150 < 160) and a ~10s Z5 burst (≥180, here 188).
// A full minute keeps the floored effort points comfortably above 1 so the
// zone-rate test has clear separation. peak sample is 188.
function buildHrSamples() {
  const base = Date.parse('2026-06-20T10:00:00Z')
  const bpms = []
  for (let i = 0; i <= 60; i++) {
    // Seconds 20–29 are the Z5 burst; everything else sits in Z3 around 150.
    bpms.push(i >= 20 && i < 30 ? 188 : 150)
  }
  return bpms.map((value, i) => ({
    timestamp: new Date(base + i * 1000).toISOString(),
    value,
    unit: 'count/min',
  }))
}

// A no-HR workout — Apple still reports aggregate avg/max even with no series.
const workoutNoHr = {
  id: 'wk_nohr_999',
  type: 'high_intensity_interval_training',
  start_time: '2026-06-20T18:30:00Z',
  end_time: '2026-06-20T19:15:00Z',
  duration_seconds: 2700,
  avg_heart_rate_bpm: 138,
  max_heart_rate_bpm: 171,
  source: 'apple_watch',
}

// ── (1) Workout with a minute of HR samples ──────────────────────

describe('mapAppleWorkoutToSession — with HR samples', () => {
  const out = mapAppleWorkoutToSession({
    workout: workoutWithHr,
    hrSamples: buildHrSamples(),
    maxHr,
    scoring,
  })

  it('sets source apple_health', () => {
    expect(out.source).toBe('apple_health')
  })
  it('carries the OW workout id as the dedup key in raw_metadata', () => {
    expect(out.raw_metadata.ow_workout_id).toBe('wk_abc123')
    expect(out.raw_metadata.ow_provider).toBe('apple')
    expect(out.raw_metadata.ow_type).toBe('functional_strength_training')
  })
  it('produces non-zero effort_points from the samples', () => {
    expect(out.effort_points).toBeGreaterThan(0)
  })
  it('populates zones_seconds with time in the worked zones', () => {
    // Mostly Z3 with two Z5 spikes → both buckets non-empty.
    expect(out.zones_seconds[3]).toBeGreaterThan(0)
    expect(out.zones_seconds[5]).toBeGreaterThan(0)
    const total = Object.values(out.zones_seconds).reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(0)
  })
  it('computes avg + peak from the samples, not the workout aggregates', () => {
    // peak sample is 188; workout aggregate max is 182 → sample wins.
    expect(out.peak_hr_bpm).toBe(188)
    expect(out.avg_hr_bpm).toBeGreaterThan(140)
    expect(out.avg_hr_bpm).toBeLessThan(160)
  })
  it('leaves caller-owned fields unset', () => {
    expect(out).not.toHaveProperty('contact_id')
    expect(out).not.toHaveProperty('location_id')
    expect(out).not.toHaveProperty('glofox_event_id')
    expect(out).not.toHaveProperty('class_name')
    expect(out).not.toHaveProperty('class_link_source')
  })
  it('records max_hr_used and a null device_identifier', () => {
    expect(out.max_hr_used).toBe(maxHr)
    expect(out.device_identifier).toBeNull()
  })
})

// ── (2) No-HR workout → participation points + aggregates ─────────

describe('mapAppleWorkoutToSession — no HR samples', () => {
  it('uses the flat participation value and empty zones, avg/peak from aggregates', () => {
    const out = mapAppleWorkoutToSession({
      workout: workoutNoHr,
      hrSamples: [],
      maxHr,
      scoring,
    })
    expect(out.effort_points).toBe(scoring.participationPoints)
    expect(out.zones_seconds).toEqual({})
    expect(out.avg_hr_bpm).toBe(138)
    expect(out.peak_hr_bpm).toBe(171)
    expect(out.source).toBe('apple_health')
    expect(out.raw_metadata.ow_workout_id).toBe('wk_nohr_999')
  })

  it('treats absent hrSamples the same as empty', () => {
    const out = mapAppleWorkoutToSession({ workout: workoutNoHr, maxHr, scoring })
    expect(out.effort_points).toBe(scoring.participationPoints)
    expect(out.zones_seconds).toEqual({})
  })

  it('falls back to null avg/peak when the workout has no aggregates', () => {
    const bare = { id: 'wk_bare', type: 'walking', start_time: 'a', end_time: 'b', source: 'x' }
    const out = mapAppleWorkoutToSession({ workout: bare, hrSamples: [], maxHr, scoring })
    expect(out.avg_hr_bpm).toBeNull()
    expect(out.peak_hr_bpm).toBeNull()
  })
})

// ── (3) HR points honour scoring.zonePoints ──────────────────────

describe('mapAppleWorkoutToSession — scoring.zonePoints is honoured', () => {
  it('doubling the Z5 rate yields more effort points', () => {
    const samples = buildHrSamples()
    const baseline = mapAppleWorkoutToSession({ workout: workoutWithHr, hrSamples: samples, maxHr, scoring })
    const doubledZ5 = mapAppleWorkoutToSession({
      workout: workoutWithHr,
      hrSamples: samples,
      maxHr,
      scoring: { ...scoring, zonePoints: { ...scoring.zonePoints, 5: 10 } },
    })
    expect(doubledZ5.effort_points).toBeGreaterThan(baseline.effort_points)
  })
})

// ── (4) started_at / ended_at mapped from the workout ────────────

describe('mapAppleWorkoutToSession — timestamps', () => {
  it('maps started_at and ended_at straight from the workout', () => {
    const out = mapAppleWorkoutToSession({ workout: workoutWithHr, hrSamples: buildHrSamples(), maxHr, scoring })
    expect(out.started_at).toBe('2026-06-20T10:00:00Z')
    expect(out.ended_at).toBe('2026-06-20T10:01:00Z')
  })
  it('null-coalesces missing start/end times', () => {
    const out = mapAppleWorkoutToSession({ workout: { id: 'x' }, hrSamples: [], maxHr, scoring })
    expect(out.started_at).toBeNull()
    expect(out.ended_at).toBeNull()
  })
})

// ── (5) Garbage samples filtered ─────────────────────────────────

describe('mapAppleWorkoutToSession — garbage sample filtering', () => {
  it('drops non-finite bpm and missing-timestamp samples but keeps the valid ones', () => {
    const dirty = [
      { timestamp: '2026-06-20T10:00:00Z', value: 150, unit: 'count/min' }, // good
      { timestamp: '2026-06-20T10:00:01Z', value: 'nope', unit: 'count/min' }, // NaN bpm
      { timestamp: '2026-06-20T10:00:02Z', value: null }, // null bpm
      { timestamp: '2026-06-20T10:00:03Z', value: Infinity }, // non-finite
      { value: 155 }, // missing timestamp
      { timestamp: '2026-06-20T10:00:05Z', value: 158, unit: 'count/min' }, // good
    ]
    const out = mapAppleWorkoutToSession({ workout: workoutWithHr, hrSamples: dirty, maxHr, scoring })
    // Two valid samples survived → HR path, not the participation path.
    expect(out.effort_points).not.toBe(scoring.participationPoints)
    expect(out.avg_hr_bpm).toBe(Math.round((150 + 158) / 2)) // 154
    expect(out.peak_hr_bpm).toBe(158)
  })

  it('falls back to the no-HR path when every sample is garbage', () => {
    const allBad = [
      { timestamp: '2026-06-20T10:00:00Z', value: 'x' },
      { value: 150 },
      { timestamp: '2026-06-20T10:00:02Z', value: NaN },
    ]
    const out = mapAppleWorkoutToSession({ workout: workoutNoHr, hrSamples: allBad, maxHr, scoring })
    expect(out.effort_points).toBe(scoring.participationPoints)
    expect(out.zones_seconds).toEqual({})
    expect(out.avg_hr_bpm).toBe(138) // from workout aggregate
  })
})

// ── (6) workout detail fields (type / calories / distance / pace) ──

describe('mapAppleWorkoutToSession — workout detail', () => {
  it('maps workout detail (type/calories/distance/pace) from the payload', () => {
    const row = mapAppleWorkoutToSession({
      workout: {
        id: 'w1', type: 'running', start_time: '2026-06-20T10:00:00Z', end_time: '2026-06-20T10:30:00Z',
        calories_kcal: 320, distance_meters: 5200, avg_pace_sec_per_km: 346,
      },
      hrSamples: [], maxHr: 190, scoring: { participationPoints: 50 },
    })
    expect(row.workout_type).toBe('running')
    expect(row.calories_kcal).toBe(320)
    expect(row.distance_meters).toBe(5200)
    expect(row.avg_pace_sec_per_km).toBe(346)
  })

  it('leaves workout detail null when absent', () => {
    const row = mapAppleWorkoutToSession({ workout: { id: 'w2' }, hrSamples: [], maxHr: 190, scoring: {} })
    expect(row.workout_type).toBeNull()
    expect(row.calories_kcal).toBeNull()
    expect(row.distance_meters).toBeNull()
    expect(row.avg_pace_sec_per_km).toBeNull()
  })
})

// ── defensive: never throws on a sparse / empty call ─────────────

describe('mapAppleWorkoutToSession — defensive', () => {
  it('returns a valid payload for an empty workout with no samples', () => {
    const out = mapAppleWorkoutToSession({ workout: {}, maxHr, scoring })
    expect(out.source).toBe('apple_health')
    expect(out.raw_metadata).toEqual({ ow_workout_id: null, ow_provider: 'apple', ow_type: null })
    expect(out.zones_seconds).toEqual({})
    expect(out.effort_points).toBe(scoring.participationPoints)
  })
  it('does not throw when called with no args at all', () => {
    expect(() => mapAppleWorkoutToSession()).not.toThrow()
  })
  it('honours a custom provider override in raw_metadata', () => {
    const out = mapAppleWorkoutToSession({ workout: { id: 'q' }, maxHr, scoring, provider: 'healthkit' })
    expect(out.raw_metadata.ow_provider).toBe('healthkit')
  })
})
