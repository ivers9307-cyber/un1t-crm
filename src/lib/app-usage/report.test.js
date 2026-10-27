import { describe, it, expect } from 'vitest'
import { rangeFor, peopleRows, featureRows, reportTotals, timeline, RANGE_KEYS } from './report.js'

describe('rangeFor', () => {
  it('counts the range inclusive of today', () => {
    expect(rangeFor('today', '2026-10-26')).toEqual({ key: 'today', from: '2026-10-26', to: '2026-10-26', days: 1 })
    expect(rangeFor('7d', '2026-10-26')).toEqual({ key: '7d', from: '2026-10-20', to: '2026-10-26', days: 7 })
    expect(rangeFor('12m', '2026-10-26')).toMatchObject({ from: '2025-10-27', days: 365 })
  })
  it('falls back to 7 days for an unknown key', () => {
    expect(rangeFor('nope', '2026-10-26').key).toBe('7d')
    expect(RANGE_KEYS).toEqual(['today', '7d', '30d', '90d', '12m'])
  })
})

const row = (profile_id, platform, feature, visits, seconds, days) => ({ profile_id, platform, feature, visits, seconds, days })
const staff = [
  { id: 'a', name: 'Aoife', tenant: 'UN1T Group' },
  { id: 'b', name: 'Conor', tenant: 'UN1T Group' },
  { id: 'c', name: 'Darragh', tenant: 'UN1T Group' },
]
const summary = [
  row('a', 'all', '_session', 35, 21900, 6),
  row('a', 'phone', '_session', 25, 15000, 6),
  row('a', 'web', '_session', 10, 7000, 3),
  row('a', 'phone', 'contacts', 40, 4800, 6),
  row('a', 'web', 'contacts', 10, 1200, 3),
  row('a', 'phone', 'inbox', 70, 4200, 6),
  row('b', 'all', '_session', 21, 13680, 5),
  row('b', 'phone', '_session', 21, 13680, 5),
  row('b', 'phone', 'contacts', 5, 600, 2),
]

describe('peopleRows', () => {
  it('builds one row per staff member, unused staff included', () => {
    const rows = peopleRows({ staff, summary, lastActive: new Map([['a', '2026-10-26T14:32:00Z']]), days: 7, platform: 'all' })
    expect(rows.map((r) => r.profileId)).toEqual(['a', 'b', 'c'])
    expect(rows[0]).toMatchObject({
      name: 'Aoife', tenant: 'UN1T Group', lastActiveAt: '2026-10-26T14:32:00Z',
      daysUsed: 6, sessions: 35, sessionsPerDay: 5, seconds: 21900, phoneSeconds: 15000, webSeconds: 7000,
    })
    expect(rows[2]).toMatchObject({ name: 'Darragh', daysUsed: 0, sessions: 0, seconds: 0, lastActiveAt: null, phoneShare: null })
  })

  it('computes the phone share from per-platform session time', () => {
    const [a] = peopleRows({ staff, summary, lastActive: new Map(), days: 7, platform: 'all' })
    expect(a.phoneShare).toBeCloseTo(15000 / 22000)
  })

  it('narrows to one platform', () => {
    const [a] = peopleRows({ staff, summary, lastActive: new Map(), days: 7, platform: 'web' })
    expect(a).toMatchObject({ seconds: 7000, sessions: 10, daysUsed: 3 })
  })
})

describe('featureRows', () => {
  it('adds phone and web together and ranks by time', () => {
    const rows = featureRows({ summary, days: 7, platform: 'all' })
    expect(rows.map((r) => r.feature)).toEqual(['contacts', 'inbox'])
    expect(rows[0]).toMatchObject({ label: 'Contacts', people: 2, visits: 55, seconds: 6600, avgVisitSec: 120 })
    expect(rows[0].visitsPerDay).toBeCloseTo(55 / 7)
  })

  it('never lists the session pseudo-feature', () => {
    expect(featureRows({ summary, days: 7, platform: 'all' }).some((r) => r.feature === '_session')).toBe(false)
  })

  it('narrows to one platform', () => {
    expect(featureRows({ summary, days: 7, platform: 'web' })).toEqual([
      expect.objectContaining({ feature: 'contacts', visits: 10, seconds: 1200, people: 1 }),
    ])
  })
})

describe('reportTotals', () => {
  it('summarises people and features', () => {
    const people = peopleRows({ staff, summary, lastActive: new Map(), days: 7, platform: 'all' })
    const features = featureRows({ summary, days: 7, platform: 'all' })
    expect(reportTotals({ people, features })).toEqual({
      activeStaff: 2, staffCount: 3, sessions: 56, seconds: 35580, topFeature: 'Contacts',
    })
  })
  it('has no top feature when nothing was used', () => {
    expect(reportTotals({ people: [], features: [] }).topFeature).toBeNull()
  })
})

describe('timeline', () => {
  it('orders sessions and their feature trail by start', () => {
    const t = timeline({
      sessions: [
        { id: 's2', platform: 'web', started_at: '2026-10-26T09:30:00Z', ended_at: '2026-10-26T11:10:00Z' },
        { id: 's1', platform: 'phone', started_at: '2026-10-26T07:05:00Z', ended_at: '2026-10-26T07:20:00Z' },
      ],
      visits: [
        { session_id: 's1', feature: 'contacts', started_at: '2026-10-26T07:10:00Z', ended_at: '2026-10-26T07:20:00Z' },
        { session_id: 's1', feature: 'schedule', started_at: '2026-10-26T07:05:00Z', ended_at: '2026-10-26T07:10:00Z' },
      ],
    })
    expect(t.map((s) => s.sessionId)).toEqual(['s1', 's2'])
    expect(t[0].trail).toEqual([
      { feature: 'schedule', label: 'Rota', seconds: 300 },
      { feature: 'contacts', label: 'Contacts', seconds: 600 },
    ])
    expect(t[1].trail).toEqual([])
  })
})
