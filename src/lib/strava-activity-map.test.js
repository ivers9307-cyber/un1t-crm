import { describe, it, expect } from 'vitest'
import { mapStravaActivity } from './strava-activity-map.js'

describe('mapStravaActivity', () => {
  it('maps an OW strava workout payload → strava_activities row', () => {
    const row = mapStravaActivity({
      contactId: 'c1',
      activity: {
        id: 'strava-987', type: 'running', name: 'Morning Run',
        start_time: '2026-06-21T06:30:00Z', end_time: '2026-06-21T07:10:00Z',
        duration_seconds: 2400, distance_meters: 8000, calories_kcal: 540,
        avg_heart_rate_bpm: 150, max_heart_rate_bpm: 178,
      },
    })
    expect(row).toMatchObject({
      contact_id: 'c1', strava_activity_id: 'strava-987', activity_type: 'running',
      name: 'Morning Run', started_at: '2026-06-21T06:30:00Z', duration_seconds: 2400,
      distance_meters: 8000, calories_kcal: 540, avg_hr_bpm: 150, max_hr_bpm: 178,
    })
    expect(row.raw_metadata).toBeTruthy()
  })
  it('returns null strava_activity_id when the activity id is missing', () => {
    expect(mapStravaActivity({ contactId: 'c1', activity: {} }).strava_activity_id).toBeNull()
  })
  it('coerces bad numerics to null and tolerates a null activity', () => {
    const row = mapStravaActivity({ contactId: 'c1', activity: { id: 'x', distance_meters: '' } })
    expect(row.distance_meters).toBeNull()
    expect(() => mapStravaActivity({ contactId: 'c1', activity: null })).not.toThrow()
  })
})
