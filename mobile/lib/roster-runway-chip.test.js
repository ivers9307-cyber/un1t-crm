// RUNWAY.1 — the mobile Studio chip's view-model. There is no React Native
// component test runner here, so what the chip SAYS, how loud it is and where
// it goes are decided (and pinned) in this module; the component only draws it.

import { describe, it, expect } from 'vitest'
import { rosterRunwayChip } from './roster-runway-chip'
import { routeForNotification } from './notification-nav'

const RUNWAY = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}

describe('rosterRunwayChip', () => {
  it('no runway -> no chip (ready, not a manager here, read failed, route not deployed)', () => {
    for (const v of [null, undefined, false, {}, { severity: 'red' }, 'amber']) {
      expect(rosterRunwayChip(v)).toBeNull()
    }
  })

  it('says which week, how far off and what is missing, and opens THAT week in Manage mode', () => {
    expect(rosterRunwayChip(RUNWAY)).toEqual({
      tone: 'amber',
      title: 'Week of 28 Sep is not ready',
      detail: 'Starts in 9 days: 34 of 34 shifts have no coach, not published. Tap to open that week.',
      route: '/(tabs)/schedule?date=2026-09-28&view=manage',
    })
  })

  it('red inside five days; anything unrecognised is amber, never an unstyled chip', () => {
    expect(rosterRunwayChip({ ...RUNWAY, daysAway: 4, severity: 'red' }).tone).toBe('red')
    expect(rosterRunwayChip({ ...RUNWAY, severity: 'purple' }).tone).toBe('amber')
    expect(rosterRunwayChip({ ...RUNWAY, severity: undefined }).tone).toBe('amber')
  })

  it("the chip's route IS the push's route, so the two cannot drift", () => {
    expect(rosterRunwayChip(RUNWAY).route)
      .toBe(routeForNotification({ type: 'roster_runway', location_id: 'l1', week_start: RUNWAY.weekStart, severity: 'amber' }))
  })

  it('counts and dates only: no names, no pay, no capacity', () => {
    const chip = rosterRunwayChip({ ...RUNWAY, hourly_rate: 40, coach: 'someone', max_coaches: 3 })
    expect(Object.keys(chip).sort()).toEqual(['detail', 'route', 'title', 'tone'])
    expect(JSON.stringify(chip)).not.toMatch(/40|someone|max/)
  })
})
