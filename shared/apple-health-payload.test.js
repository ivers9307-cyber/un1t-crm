import { describe, it, expect } from 'vitest'
import { buildAppleHealthPayload, normalizeActivityType } from './apple-health-payload.js'

describe('normalizeActivityType', () => {
  it('maps HK identifiers (with or without prefix) to snake_case keys', () => {
    expect(normalizeActivityType('HKWorkoutActivityTypeRunning')).toBe('running')
    expect(normalizeActivityType('Running')).toBe('running')
    expect(normalizeActivityType('HKWorkoutActivityTypeFunctionalStrengthTraining')).toBe('functional_strength_training')
    expect(normalizeActivityType('HighIntensityIntervalTraining')).toBe('high_intensity_interval_training')
    expect(normalizeActivityType(null)).toBe('other')
    expect(normalizeActivityType('')).toBe('other')
  })
})

describe('buildAppleHealthPayload', () => {
  it('shapes a workout, windows HR samples to its time range, ISO-stamps dates', () => {
    const start = new Date('2026-06-23T08:00:00Z')
    const end = new Date('2026-06-23T08:30:00Z')
    const out = buildAppleHealthPayload({
      workouts: [{
        uuid: 'HK-1', activityType: 'HKWorkoutActivityTypeRunning',
        startDate: start, endDate: end, energyKcal: 300, distanceMeters: 5000,
        avgHeartRateBpm: 150, maxHeartRateBpm: 175,
      }],
      hrSamples: [
        { date: '2026-06-23T08:10:00Z', bpm: 148 }, // inside
        { date: '2026-06-23T08:20:00Z', bpm: 160 }, // inside
        { date: '2026-06-23T09:00:00Z', bpm: 90 },  // outside window → dropped
      ],
    })
    expect(out.workouts).toHaveLength(1)
    const { workout, hrSamples } = out.workouts[0]
    expect(workout.id).toBe('HK-1')
    expect(workout.type).toBe('running')
    expect(workout.start_time).toBe('2026-06-23T08:00:00.000Z')
    expect(workout.calories_kcal).toBe(300)
    expect(workout.distance_meters).toBe(5000)
    expect(hrSamples).toEqual([
      { timestamp: '2026-06-23T08:10:00.000Z', value: 148 },
      { timestamp: '2026-06-23T08:20:00.000Z', value: 160 },
    ])
  })

  it('maps health metrics + drops invalid ones', () => {
    const out = buildAppleHealthPayload({
      metrics: [
        { metric: 'resting_heart_rate', date: '2026-06-23T06:00:00Z', value: 52, unit: 'bpm' },
        { metric: 'vo2max', date: '2026-06-23T06:00:00Z', value: 48 },
        { metric: 'bad', date: '2026-06-23T06:00:00Z', value: null }, // dropped
        { metric: 'no_date', date: null, value: 5 },                  // dropped
      ],
    })
    expect(out.healthMetrics).toEqual([
      { metric: 'resting_heart_rate', recorded_at: '2026-06-23T06:00:00.000Z', value: 52, unit: 'bpm' },
      { metric: 'vo2max', recorded_at: '2026-06-23T06:00:00.000Z', value: 48, unit: null },
    ])
  })

  it('drops workouts missing uuid or dates; tolerates empty input', () => {
    expect(buildAppleHealthPayload()).toEqual({ workouts: [], healthMetrics: [] })
    const out = buildAppleHealthPayload({ workouts: [{ activityType: 'running', startDate: '2026-06-23T08:00:00Z' }] })
    expect(out.workouts).toHaveLength(0)
  })

  it('accepts ISO-string dates too (not just Date objects)', () => {
    const out = buildAppleHealthPayload({
      workouts: [{ uuid: 'HK-2', activityType: 'walking', startDate: '2026-06-23T08:00:00Z', endDate: '2026-06-23T08:20:00Z' }],
    })
    expect(out.workouts[0].workout.start_time).toBe('2026-06-23T08:00:00.000Z')
    expect(out.workouts[0].workout.type).toBe('walking')
  })
})

describe('buildAppleHealthPayload — body block', () => {
  it('emits a body block from weight + characteristics', () => {
    const out = buildAppleHealthPayload({ body: { weightKg: 70.2, weightAt: '2026-06-27T08:00:00Z', dob: '1990-03-12', biologicalSex: 'male' } })
    expect(out.body).toEqual({ weight_kg: 70.2, weight_at: '2026-06-27T08:00:00.000Z', dob: '1990-03-12', biological_sex: 'male' })
  })
  it('omits the body block entirely when there is nothing to send', () => {
    expect(buildAppleHealthPayload({}).body).toBeUndefined()
    expect(buildAppleHealthPayload({ body: { weightKg: null, dob: null, biologicalSex: null } }).body).toBeUndefined()
  })
  it('includes only the present fields', () => {
    const out = buildAppleHealthPayload({ body: { weightKg: 68 } })
    expect(out.body).toEqual({ weight_kg: 68 })
  })
})
