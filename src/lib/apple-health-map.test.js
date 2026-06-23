import { describe, it, expect } from 'vitest'
import { mapAppleHealthWorkoutToSession } from './apple-health-map.js'

const scoring = { zonePoints: { 1: 1, 2: 2, 3: 4, 4: 8, 5: 12 }, participationPoints: 10 }

describe('mapAppleHealthWorkoutToSession', () => {
  it('HR path: computes zones/points/avg/peak from samples; stamps apple_workout_uuid (no ow_* keys)', () => {
    const workout = {
      id: 'HK-UUID-1', type: 'running',
      start_time: '2026-06-23T08:00:00Z', end_time: '2026-06-23T08:40:00Z',
      calories_kcal: 420, distance_meters: 8000,
    }
    // 40 one-minute samples at a steady 150 bpm.
    const hrSamples = Array.from({ length: 40 }, (_, i) => ({
      timestamp: new Date(Date.parse(workout.start_time) + i * 60000).toISOString(),
      value: 150,
    }))
    const out = mapAppleHealthWorkoutToSession({ workout, hrSamples, maxHr: 190, scoring })

    expect(out.source).toBe('apple_health')
    expect(out.raw_metadata.apple_workout_uuid).toBe('HK-UUID-1')
    expect(out.raw_metadata.apple_workout_type).toBe('running')
    expect(out.raw_metadata).not.toHaveProperty('ow_workout_id')
    expect(out.raw_metadata).not.toHaveProperty('ow_provider')
    expect(out.device_identifier).toBeNull()
    expect(out.started_at).toBe('2026-06-23T08:00:00Z')
    expect(out.calories_kcal).toBe(420)
    expect(out.distance_meters).toBe(8000)
    expect(out.effort_points).toBeGreaterThan(0)
    expect(out.avg_hr_bpm).toBe(150)
    expect(out.peak_hr_bpm).toBe(150)
    expect(Object.keys(out.zones_seconds).length).toBeGreaterThan(0)
  })

  it('no-HR path: flat participation points, empty zones, avg/peak from aggregates', () => {
    const workout = {
      id: 'HK-2', type: 'walking',
      start_time: '2026-06-23T08:00:00Z', end_time: '2026-06-23T08:30:00Z',
      avg_heart_rate_bpm: 110, max_heart_rate_bpm: 130,
    }
    const out = mapAppleHealthWorkoutToSession({ workout, hrSamples: [], maxHr: 190, scoring })

    expect(out.effort_points).toBe(10)
    expect(out.zones_seconds).toEqual({})
    expect(out.avg_hr_bpm).toBe(110)
    expect(out.peak_hr_bpm).toBe(130)
    expect(out.raw_metadata.apple_workout_uuid).toBe('HK-2')
  })

  it('is defensive on a sparse/empty workout (never throws)', () => {
    const out = mapAppleHealthWorkoutToSession({ workout: {}, hrSamples: null, maxHr: 190, scoring })
    expect(out.source).toBe('apple_health')
    expect(out.started_at).toBeNull()
    expect(out.raw_metadata.apple_workout_uuid).toBeNull()
    expect(out.effort_points).toBe(10) // participation fallback
    expect(out.calories_kcal).toBeNull()
  })

  it('drops null/empty bpm samples (missing data ≠ a real zero reading)', () => {
    const workout = { id: 'HK-3', type: 'running', start_time: '2026-06-23T08:00:00Z', end_time: '2026-06-23T08:05:00Z', avg_heart_rate_bpm: 99 }
    const hrSamples = [
      { timestamp: '2026-06-23T08:00:00Z', value: null },
      { timestamp: '2026-06-23T08:01:00Z', value: '' },
      { timestamp: null, value: 150 },
    ]
    // All three are unusable → no-HR path.
    const out = mapAppleHealthWorkoutToSession({ workout, hrSamples, maxHr: 190, scoring })
    expect(out.effort_points).toBe(10)
    expect(out.avg_hr_bpm).toBe(99)
  })
})
