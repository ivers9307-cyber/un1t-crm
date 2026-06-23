import { describe, it, expect } from 'vitest'
import { mapStravaApiActivity } from './strava-direct-map.js'

describe('mapStravaApiActivity', () => {
  it('maps a detailed Strava activity → strava_activities row', () => {
    const row = mapStravaApiActivity({
      contactId: 'c1', athleteId: '883513483',
      activity: {
        id: 19032691312, name: 'Morning Run', type: 'Run', sport_type: 'Run',
        start_date: '2026-06-23T08:00:00Z', moving_time: 4200, elapsed_time: 4300,
        distance: 10000, calories: 640, average_heartrate: 151, max_heartrate: 176,
      },
    })
    expect(row).toMatchObject({
      contact_id: 'c1', strava_activity_id: '19032691312', activity_type: 'Run',
      name: 'Morning Run', started_at: '2026-06-23T08:00:00Z', duration_seconds: 4200,
      distance_meters: 10000, calories_kcal: 640, avg_hr_bpm: 151, max_hr_bpm: 176,
    })
    expect(row.raw_metadata.source).toBe('strava')
    expect(row.raw_metadata.strava_athlete_id).toBe('883513483')
  })
  it('summary activity (no calories) → null calories; falls back to elapsed_time', () => {
    const row = mapStravaApiActivity({ contactId: 'c1', activity: { id: 7, type: 'Ride', elapsed_time: 1800 } })
    expect(row.calories_kcal).toBeNull()
    expect(row.duration_seconds).toBe(1800)
  })
  it('null id → null strava_activity_id; bad numerics → null; tolerates null activity', () => {
    expect(mapStravaApiActivity({ contactId: 'c1', activity: {} }).strava_activity_id).toBeNull()
    expect(mapStravaApiActivity({ contactId: 'c1', activity: { id: 'x', distance: '' } }).distance_meters).toBeNull()
    expect(() => mapStravaApiActivity({ contactId: 'c1', activity: null })).not.toThrow()
  })
})
