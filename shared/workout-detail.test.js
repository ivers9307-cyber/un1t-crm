import { describe, it, expect } from 'vitest'
import { workoutLabel, workoutIcon, formatPace, formatDistance, formatDuration, sessionDetailChips } from './workout-detail.js'

describe('workout-detail', () => {
  it('labels known workout types and title-cases unknown', () => {
    expect(workoutLabel('functional_strength_training')).toBe('Strength')
    expect(workoutLabel('running')).toBe('Run')
    expect(workoutLabel('open_water_swim')).toBe('Open Water Swim')
    expect(workoutLabel(null)).toBe('Workout')
  })
  it('maps types to an icon key (default for unknown)', () => {
    expect(workoutIcon('running')).toBe('run')
    expect(workoutIcon('cycling')).toBe('bike')
    expect(workoutIcon('mystery')).toBe('activity')
  })
  it('formats pace as m:ss /km and distance as km', () => {
    expect(formatPace(346)).toBe('5:46 /km')
    expect(formatPace(null)).toBeNull()
    expect(formatDistance(5200)).toBe('5.20 km')
    expect(formatDistance(null)).toBeNull()
  })
  it('builds only the chips that have data', () => {
    expect(sessionDetailChips({ calories_kcal: 320, distance_meters: 5200, avg_pace_sec_per_km: 346 }))
      .toEqual([{ key: 'calories', label: '320 kcal' }, { key: 'distance', label: '5.20 km' }, { key: 'pace', label: '5:46 /km' }])
    expect(sessionDetailChips({ calories_kcal: null, distance_meters: null, avg_pace_sec_per_km: null })).toEqual([])
  })
  it('formats duration from seconds, null on bad input', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(60)).toBe('1 min')
    expect(formatDuration(2400)).toBe('40 min')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(3900)).toBe('1h 5m')
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration('')).toBeNull()
    expect(formatDuration('abc')).toBeNull()
  })
})
