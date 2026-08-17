import { describe, it, expect } from 'vitest'
import { groupSessionsByMonth, lifetimeMilestones } from './session-history.js'
import { buildSessionsList } from './sessions-list.js'

const DAY = 24 * 3600 * 1000

// A UN1T session `daysAgo` before a fixed "now", 45 min, 100 pts by default.
const NOW = Date.parse('2026-06-21T12:00:00Z') // a Sunday
const sAt = (daysAgo, over = {}) => ({
  id: `s-${daysAgo}-${Math.random().toString(36).slice(2, 6)}`,
  started_at: new Date(NOW - daysAgo * DAY).toISOString(),
  ended_at: new Date(NOW - daysAgo * DAY + 45 * 60000).toISOString(),
  effort_points: 100,
  ...over,
})

describe('groupSessionsByMonth', () => {
  it('groups items into per-month sections, newest month first', () => {
    // Two June sessions, one May session.
    const items = buildSessionsList({
      sessions: [sAt(1), sAt(2), sAt(40)],
    })
    const sections = groupSessionsByMonth(items)
    expect(sections.map((s) => s.title)).toEqual(['June 2026', 'May 2026'])
    expect(sections[0].sessionCount).toBe(2)
    expect(sections[1].sessionCount).toBe(1)
  })

  it('per-month stat line sums UN1T points + session count', () => {
    const items = buildSessionsList({
      sessions: [
        sAt(1, { effort_points: 120 }),
        sAt(2, { effort_points: 80 }),
      ],
    })
    const [june] = groupSessionsByMonth(items)
    expect(june.sessionCount).toBe(2)
    expect(june.points).toBe(200)
  })

  it('Strava rows render in-month but do NOT count toward the stat line', () => {
    const items = buildSessionsList({
      sessions: [sAt(1, { effort_points: 100 })],
      stravaActivities: [
        {
          strava_activity_id: 'a1',
          activity_type: 'Run',
          started_at: new Date(NOW - 3 * DAY).toISOString(),
        },
      ],
    })
    const [june] = groupSessionsByMonth(items)
    expect(june.data).toHaveLength(2) // both render
    expect(june.sessionCount).toBe(1) // only the UN1T session counts
    expect(june.points).toBe(100)
  })

  it('uses Europe/Dublin month boundaries (a session at 00:30 IST stays in July)', () => {
    // 2026-07-01T00:30 Dublin (IST, UTC+1) === 2026-06-30T23:30Z. Dublin month
    // must be July, not June.
    const items = buildSessionsList({
      sessions: [{ id: 'x', started_at: '2026-06-30T23:30:00Z', effort_points: 50 }],
    })
    const [section] = groupSessionsByMonth(items)
    expect(section.title).toBe('July 2026')
  })

  it('items with no timestamp collect into a trailing Undated section', () => {
    const items = buildSessionsList({
      sessions: [sAt(1), { id: 'bad', started_at: null, effort_points: 10 }],
    })
    const sections = groupSessionsByMonth(items)
    const undated = sections.find((s) => s.title === 'Undated')
    expect(undated).toBeTruthy()
    expect(undated.data).toHaveLength(1)
    expect(sections[sections.length - 1].title).toBe('Undated') // trailing
  })

  it('empty input → empty array', () => {
    expect(groupSessionsByMonth([])).toEqual([])
    expect(groupSessionsByMonth()).toEqual([])
  })
})

describe('lifetimeMilestones', () => {
  it('totals sessions, points, minutes/hours from raw sessions', () => {
    const m = lifetimeMilestones([
      sAt(1, { effort_points: 100 }),
      sAt(2, { effort_points: 50 }),
    ], NOW)
    expect(m.totalSessions).toBe(2)
    expect(m.totalPoints).toBe(150)
    expect(m.totalMinutes).toBe(90)
    expect(m.totalHours).toBe(1)
  })

  it('surfaces the largest crossed session threshold', () => {
    const many = Array.from({ length: 120 }, (_, i) => sAt(i + 1, { effort_points: 0 }))
    const m = lifetimeMilestones(many, NOW)
    const s = m.milestones.find((x) => x.kind === 'sessions')
    expect(s.threshold).toBe(100) // 120 crosses 100, not yet 150
    expect(s.label).toContain('100 times')
  })

  it('no session milestone below the first threshold (10)', () => {
    const m = lifetimeMilestones([sAt(1), sAt(2)], NOW)
    expect(m.milestones.find((x) => x.kind === 'sessions')).toBeUndefined()
  })

  it('surfaces a points milestone at a round number', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => sAt(i + 1, { effort_points: 300 }))
    const m = lifetimeMilestones(sessions, NOW) // 3000 pts
    const p = m.milestones.find((x) => x.kind === 'points')
    expect(p.threshold).toBe(2500)
  })

  it('surfaces a longest-streak milestone only at 5+ days', () => {
    const streaky = [1, 2, 3, 4, 5, 6].map((d) => sAt(d))
    const m = lifetimeMilestones(streaky, NOW)
    const st = m.milestones.find((x) => x.kind === 'streak')
    expect(st).toBeTruthy()
    expect(m.longestStreak).toBeGreaterThanOrEqual(5)

    const short = [sAt(1), sAt(2)]
    expect(lifetimeMilestones(short, NOW).milestones.find((x) => x.kind === 'streak')).toBeUndefined()
  })

  it('empty input → zeroed totals, no milestones', () => {
    const m = lifetimeMilestones([], NOW)
    expect(m).toMatchObject({ totalSessions: 0, totalPoints: 0, totalHours: 0, longestStreak: 0 })
    expect(m.milestones).toEqual([])
  })
})
