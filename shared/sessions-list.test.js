import { describe, it, expect } from 'vitest'
import { buildSessionsList } from './sessions-list.js'

// Member-own heart_rate_sessions (points/zone-bearing) + personal-only Strava
// activities (mig 308). The Sessions screen interleaves both for DISPLAY only —
// Strava items never carry points/zones and this helper is never consumed by a
// cross-member surface (Strava API Policy §5.4).
const SESSIONS = [
  { id: 's1', started_at: '2026-06-23T07:00:00Z', source: 'ble_bridge', effort_points: 42, zones_seconds: { z3: 600 } },
  { id: 's2', started_at: '2026-06-20T18:00:00Z', source: 'apple_health', effort_points: 30 },
]
const STRAVA = [
  { strava_activity_id: '19035608444', name: 'run run run', started_at: '2026-06-23T12:10:00Z', distance_meters: 0, duration_seconds: 5400 },
  { strava_activity_id: '19028200401', name: 'Night Run', started_at: '2026-06-22T21:40:00Z', distance_meters: 5000, duration_seconds: 3600 },
]

describe('buildSessionsList', () => {
  it('merges sessions + strava into one list, newest-first', () => {
    const items = buildSessionsList({ sessions: SESSIONS, stravaActivities: STRAVA })
    expect(items.map((i) => i.key)).toEqual([
      'strava:19035608444', // 06-23 12:10
      'session:s1',         // 06-23 07:00
      'strava:19028200401', // 06-22 21:40
      'session:s2',         // 06-20 18:00
    ])
  })

  it('tags kind and nests the original payload untouched', () => {
    const items = buildSessionsList({ sessions: SESSIONS, stravaActivities: STRAVA })
    const sess = items.find((i) => i.key === 'session:s1')
    expect(sess.kind).toBe('session')
    expect(sess.session).toBe(SESSIONS[0])
    const str = items.find((i) => i.key === 'strava:19035608444')
    expect(str.kind).toBe('strava')
    expect(str.activity).toBe(STRAVA[0])
  })

  it('never attaches points/zones to a strava item (display-only, §5.4)', () => {
    const items = buildSessionsList({ sessions: [], stravaActivities: STRAVA })
    expect(items).toHaveLength(2)
    for (const i of items) {
      expect(i.kind).toBe('strava')
      expect(i).not.toHaveProperty('effort_points')
      expect(i).not.toHaveProperty('zones_seconds')
    }
  })

  it('handles missing / empty inputs', () => {
    expect(buildSessionsList()).toEqual([])
    expect(buildSessionsList({})).toEqual([])
    expect(buildSessionsList({ sessions: SESSIONS })).toHaveLength(2)
    expect(buildSessionsList({ stravaActivities: STRAVA })).toHaveLength(2)
  })

  it('sorts items with a missing/invalid started_at last', () => {
    const items = buildSessionsList({
      sessions: [{ id: 'noTime' }, { id: 's1', started_at: '2026-06-23T07:00:00Z' }],
      stravaActivities: [],
    })
    expect(items[0].key).toBe('session:s1')
    expect(items[items.length - 1].key).toBe('session:noTime')
  })
})
