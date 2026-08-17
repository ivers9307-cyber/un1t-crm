// Tests for shared/onboarding-journey.js — display shaping for the
// first-90-days journey card (Pulse hub sub-project 1).
//
// Contract under test (see un1t-crm docs/superpowers/specs/
// 2026-06-28-pulse-hub-first-90-days-design.md):
//   shapeJourneyCard(journey) → null when the card must not render
//   (journey null / expired / completed more than 3 days ago), else
//   { ringPct, ticks, weekLabel, countLabel, message }.
//
// HARD PRODUCT CONSTRAINT (Richard, pulse-scope-no-booking): the member
// nudge is purely motivational — NO copy variant may contain booking
// language. The booking-language test below is the enforcement.

import { describe, it, expect } from 'vitest'
import { shapeJourneyCard, JOURNEY_CARD_STATUSES } from './onboarding-journey.js'

// A representative in-window journey row as returned by un1t-crm's
// GET /api/me/journey (journeyStatus shape).
function journey(overrides = {}) {
  return {
    inWindow: true,
    dayIndex: 14,
    weekIndex: 3,
    attended: 4,
    target: 9,
    windowDays: 42,
    expectedByNow: 3,
    status: 'on_track',
    ...overrides,
  }
}

describe('shapeJourneyCard — hide rules', () => {
  it('returns null for null / undefined / non-object journeys', () => {
    expect(shapeJourneyCard(null)).toBeNull()
    expect(shapeJourneyCard(undefined)).toBeNull()
    expect(shapeJourneyCard('nope')).toBeNull()
    expect(shapeJourneyCard(42)).toBeNull()
  })

  it('returns null when the window has expired', () => {
    expect(shapeJourneyCard(journey({ status: 'expired', dayIndex: 43 }))).toBeNull()
  })

  it('returns null when the API says out-of-window', () => {
    expect(shapeJourneyCard(journey({ inWindow: false }))).toBeNull()
  })

  it('completed: celebrates for 3 days, then hides', () => {
    const done = (completedDaysAgo) =>
      journey({ status: 'completed', attended: 9, completedDaysAgo })
    expect(shapeJourneyCard(done(0))).not.toBeNull()
    expect(shapeJourneyCard(done(3))).not.toBeNull()
    expect(shapeJourneyCard(done(4))).toBeNull()
    expect(shapeJourneyCard(done(10))).toBeNull()
    // Recency unknown on every field → still celebrate (server hides
    // via journey:null at window end).
    expect(shapeJourneyCard(done(undefined))).not.toBeNull()
  })

  it('completed keeps celebrating when inWindow is false (celebration tail)', () => {
    // The server serves a completed journey with inWindow:false through the
    // celebration tail (loadContactJourney). Regression: 'completed' must be
    // handled BEFORE the inWindow guard, or a member who crosses the target
    // in the last few days of their window never sees the celebration.
    const tail = (completedDaysAgo) =>
      journey({ status: 'completed', inWindow: false, attended: 9, completedDaysAgo })
    expect(shapeJourneyCard(tail(0))).not.toBeNull()
    expect(shapeJourneyCard(tail(2))).not.toBeNull()
    // …and still hides once the 3-day celebration passes, even out-of-window.
    expect(shapeJourneyCard(tail(4))).toBeNull()
  })

  it('completed: falls back to daysSinceLastAttended when completedDaysAgo is absent', () => {
    // The pure journeyStatus row (un1t-crm A1) carries
    // daysSinceLastAttended but NOT completedDaysAgo. The last class is
    // never before the target-crossing class, so this proxy only ever
    // hides late, never early — a day-10 finisher who stops attending
    // hides 4 days after their final class, not at window end.
    const done = (daysSinceLastAttended) =>
      journey({ status: 'completed', attended: 9, daysSinceLastAttended })
    expect(shapeJourneyCard(done(0))).not.toBeNull()
    expect(shapeJourneyCard(done(3))).not.toBeNull()
    expect(shapeJourneyCard(done(4))).toBeNull()
    expect(shapeJourneyCard(done(10))).toBeNull()
    // null = never attended (can't be completed in practice, but the
    // shaper must not read null as "completed today" — fail open).
    expect(shapeJourneyCard(done(null))).not.toBeNull()
  })

  it('completed: exact completedDaysAgo wins over the last-attendance proxy', () => {
    // Finished 10 days ago but attended yesterday: the spec rule keys
    // on completion recency, so the card hides even though the member
    // is still coming to class.
    expect(
      shapeJourneyCard(
        journey({ status: 'completed', attended: 11, completedDaysAgo: 10, daysSinceLastAttended: 1 })
      )
    ).toBeNull()
    // And the exact field keeps the celebration when fresh, whatever
    // the proxy says (malformed proxy must not override it).
    expect(
      shapeJourneyCard(
        journey({ status: 'completed', attended: 9, completedDaysAgo: 1, daysSinceLastAttended: 'x' })
      )
    ).not.toBeNull()
  })
})

describe('shapeJourneyCard — shape', () => {
  it('shapes a mid-window on-track journey', () => {
    const card = shapeJourneyCard(journey())
    expect(card.ringPct).toBe(44) // round(4/9 × 100)
    expect(card.ticks).toHaveLength(9)
    expect(card.ticks.slice(0, 4).every((t) => t.filled)).toBe(true)
    expect(card.ticks.slice(4).every((t) => !t.filled)).toBe(true)
    expect(card.weekLabel).toBe('Week 3 of 6')
    expect(card.week).toBe(3)
    expect(card.totalWeeks).toBe(6)
    expect(card.countLabel).toBe('4 of 9 classes')
    expect(typeof card.message).toBe('string')
    expect(card.message.length).toBeGreaterThan(0)
  })

  it('week/totalWeeks numerically mirror weekLabel (the tick bar needs numbers)', () => {
    const card = shapeJourneyCard(journey({ weekIndex: 7, dayIndex: 41 })) // clamps to window
    expect(card.week).toBe(6)
    expect(card.totalWeeks).toBe(6)
    expect(card.weekLabel).toBe(`Week ${card.week} of ${card.totalWeeks}`)
  })

  it('ringPct and ticks clamp when attended exceeds target', () => {
    const card = shapeJourneyCard(journey({ status: 'completed', attended: 11, completedDaysAgo: 1 }))
    expect(card.ringPct).toBe(100)
    expect(card.ticks).toHaveLength(9)
    expect(card.ticks.every((t) => t.filled)).toBe(true)
  })

  it('tracks per-location config overrides (target 6, window 28)', () => {
    const card = shapeJourneyCard(
      journey({ target: 6, windowDays: 28, attended: 2, weekIndex: 2, dayIndex: 9 })
    )
    expect(card.ticks).toHaveLength(6)
    expect(card.weekLabel).toBe('Week 2 of 4')
    expect(card.week).toBe(2)
    expect(card.totalWeeks).toBe(4)
    expect(card.countLabel).toBe('2 of 6 classes')
    expect(card.ringPct).toBe(33) // round(2/6 × 100)
  })

  it('derives the week from dayIndex when weekIndex is missing, clamped to the window', () => {
    expect(shapeJourneyCard(journey({ weekIndex: undefined, dayIndex: 0 })).weekLabel).toBe('Week 1 of 6')
    expect(shapeJourneyCard(journey({ weekIndex: undefined, dayIndex: 13 })).weekLabel).toBe('Week 2 of 6')
    expect(shapeJourneyCard(journey({ weekIndex: undefined, dayIndex: 41 })).weekLabel).toBe('Week 6 of 6')
    // A weekIndex past the window never renders 'Week 7 of 6'.
    expect(shapeJourneyCard(journey({ weekIndex: 7, dayIndex: 41 })).weekLabel).toBe('Week 6 of 6')
  })

  it('sanitises malformed numbers instead of rendering NaN', () => {
    const card = shapeJourneyCard(journey({ attended: 'x', target: null, weekIndex: 'y', windowDays: 'z' }))
    expect(card.ringPct).toBe(0)
    expect(card.ticks).toHaveLength(9) // default target
    expect(card.ticks.every((t) => !t.filled)).toBe(true)
    expect(card.countLabel).toBe('0 of 9 classes')
    expect(card.weekLabel).toBe('Week 3 of 6') // derived from dayIndex 14
  })
})

describe('shapeJourneyCard — copy', () => {
  // Every renderable status variant, plus the zero-attendance opener.
  const variants = [
    journey({ status: 'on_track', attended: 0, dayIndex: 2, weekIndex: 1 }),
    journey({ status: 'on_track' }),
    journey({ status: 'behind', attended: 2 }),
    journey({ status: 'at_risk', attended: 1, dayIndex: 20, weekIndex: 3 }),
    journey({ status: 'completed', attended: 9, completedDaysAgo: 0 }),
    journey({ status: 'something_new' }), // unknown status must not crash or go blank
  ]

  it('NO variant contains booking language (pulse-scope-no-booking)', () => {
    for (const j of variants) {
      const card = shapeJourneyCard(j)
      expect(card).not.toBeNull()
      expect(card.message).not.toMatch(/book/i)
      // Belt-and-braces: the labels are numeric but check the whole card.
      expect(JSON.stringify(card)).not.toMatch(/book/i)
    }
  })

  it('copy varies by status', () => {
    const msg = (status, extra = {}) => shapeJourneyCard(journey({ status, ...extra })).message
    const onTrack = msg('on_track')
    const behind = msg('behind', { attended: 2 })
    const atRisk = msg('at_risk', { attended: 1 })
    const completed = msg('completed', { attended: 9, completedDaysAgo: 0 })
    const all = [onTrack, behind, atRisk, completed]
    expect(new Set(all).size).toBe(all.length)
  })

  it('zero-attendance on_track gets the welcome opener, not "right on pace"', () => {
    const fresh = shapeJourneyCard(journey({ status: 'on_track', attended: 0, dayIndex: 1, weekIndex: 1 }))
    const rolling = shapeJourneyCard(journey({ status: 'on_track', attended: 3 }))
    expect(fresh.message).not.toBe(rolling.message)
  })

  it('unknown statuses fall back to motivational copy', () => {
    const card = shapeJourneyCard(journey({ status: 'mystery' }))
    expect(card.message.length).toBeGreaterThan(0)
    expect(card.message).not.toMatch(/book/i)
  })

  it('exports the renderable status list for the card component', () => {
    expect(JOURNEY_CARD_STATUSES).toEqual(['on_track', 'behind', 'at_risk', 'completed'])
  })

  it('never abbreviates zones (customer copy says "Zone 4", not "Z4")', () => {
    for (const j of variants) {
      expect(shapeJourneyCard(j).message).not.toMatch(/\bZ[1-5]\b/)
    }
  })
})
