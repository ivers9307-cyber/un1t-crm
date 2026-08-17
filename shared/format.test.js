import { describe, it, expect } from 'vitest'
import { sourceLabel, durationMinutes, sessionDate, workoutTypeLabel, formatPace, formatDistanceKm } from './format.js'

describe('sourceLabel', () => {
  it('maps known sources to friendly labels', () => {
    expect(sourceLabel('ble_bridge')).toBe('In-studio')
    expect(sourceLabel('apple_health')).toBe('Apple Health')
    expect(sourceLabel('whoop')).toBe('Whoop')
  })
  it('passes through an unknown source; falls back when empty', () => {
    expect(sourceLabel('strava')).toBe('strava')
    expect(sourceLabel(null)).toBe('Session')
  })
})

describe('durationMinutes', () => {
  it('rounds to whole minutes, minimum 1', () => {
    expect(durationMinutes('2026-06-19T10:00:00Z', '2026-06-19T10:45:30Z')).toBe(46)
    expect(durationMinutes('2026-06-19T10:00:00Z', '2026-06-19T10:00:10Z')).toBe(1)
  })
  it('returns null when an endpoint is missing', () => {
    expect(durationMinutes('2026-06-19T10:00:00Z', null)).toBeNull()
    expect(durationMinutes(null, '2026-06-19T10:45:00Z')).toBeNull()
  })
})

describe('sessionDate', () => {
  it('formats a weekday + day + month in Dublin time', () => {
    expect(sessionDate('2026-06-19T10:00:00Z')).toBe('Fri, 19 Jun')
  })
  it('empty input → empty string', () => {
    expect(sessionDate(null)).toBe('')
  })
})

describe('workoutTypeLabel', () => {
  it('maps the numeric HK rawValue (incl. numeric strings) to a label', () => {
    expect(workoutTypeLabel(50)).toBe('Strength Training')   // traditionalStrengthTraining
    expect(workoutTypeLabel('50')).toBe('Strength Training')
    expect(workoutTypeLabel(37)).toBe('Running')
    expect(workoutTypeLabel(63)).toBe('HIIT')
    expect(workoutTypeLabel(52)).toBe('Walking')
  })
  it('unknown number / Other → "Workout"; empty → null', () => {
    expect(workoutTypeLabel(9999)).toBe('Workout')
    expect(workoutTypeLabel(3000)).toBe('Workout')
    expect(workoutTypeLabel(null)).toBeNull()
    expect(workoutTypeLabel('')).toBeNull()
  })
  it('title-cases a string identifier / snake_case key', () => {
    expect(workoutTypeLabel('HKWorkoutActivityTypeRunning')).toBe('Running')
    expect(workoutTypeLabel('functional_strength_training')).toBe('Functional Strength Training')
  })
})

describe('formatPace', () => {
  it('formats seconds-per-km as m:ss', () => {
    expect(formatPace(330)).toBe('5:30')
    expect(formatPace(300)).toBe('5:00')
    expect(formatPace(65)).toBe('1:05')
  })
  it('null for missing/invalid', () => {
    expect(formatPace(null)).toBeNull()
    expect(formatPace(0)).toBeNull()
  })
  it('rounds the total first — never produces ":60"', () => {
    // REGRESSION: rounding min + sec independently gave 359.7 → "5:60".
    // Correct is to round the total (360s) → "6:00".
    expect(formatPace(359.7)).toBe('6:00')
    expect(formatPace(359.5)).toBe('6:00')
    expect(formatPace(359.4)).toBe('5:59')
    expect(formatPace(119.6)).toBe('2:00')
  })
})

describe('formatDistanceKm', () => {
  it('metres → km (2 dp)', () => {
    expect(formatDistanceKm(5200)).toBe('5.20')
    expect(formatDistanceKm(850)).toBe('0.85')
  })
  it('null for missing/invalid', () => {
    expect(formatDistanceKm(null)).toBeNull()
    expect(formatDistanceKm(0)).toBeNull()
  })
})
