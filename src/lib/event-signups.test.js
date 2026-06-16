// Tests for the /events signup-summary helpers. Pure, Node env.

import { describe, it, expect } from 'vitest'
import {
  computeSignupCounts,
  formatSignupSummary,
  loadForMode,
  spotsLeft,
  wouldFit,
  sumWaveCapacity,
} from './event-signups.js'

const confirmed = (size) => ({ status: 'confirmed', team: size === undefined ? undefined : { size } })

describe('computeSignupCounts', () => {
  it('returns zeroes for null / undefined / empty input', () => {
    expect(computeSignupCounts(null)).toEqual({ people: 0, signups: 0 })
    expect(computeSignupCounts(undefined)).toEqual({ people: 0, signups: 0 })
    expect(computeSignupCounts([])).toEqual({ people: 0, signups: 0 })
  })

  it('counts a confirmed solo as 1 person, 1 signup', () => {
    expect(computeSignupCounts([confirmed(1)])).toEqual({ people: 1, signups: 1 })
  })

  it('counts a confirmed team by its size but as 1 signup', () => {
    expect(computeSignupCounts([confirmed(4)])).toEqual({ people: 4, signups: 1 })
  })

  it('sums people across confirmed registrations', () => {
    expect(computeSignupCounts([confirmed(2), confirmed(1), confirmed(8)]))
      .toEqual({ people: 11, signups: 3 })
  })

  it('excludes non-confirmed registrations (cancelled, no_show, pending_payment)', () => {
    const regs = [
      confirmed(2),
      confirmed(1),
      { status: 'cancelled', team: { size: 5 } },
      { status: 'no_show', team: { size: 4 } },
      { status: 'pending_payment', team: { size: 3 } },
    ]
    expect(computeSignupCounts(regs)).toEqual({ people: 3, signups: 2 })
  })

  it('falls back to 1 person when a confirmed reg has no usable team size', () => {
    // Defensive: a confirmed registration always represents at least one
    // person, even if the team row / size is missing or invalid.
    expect(computeSignupCounts([confirmed(undefined)])).toEqual({ people: 1, signups: 1 })
    expect(computeSignupCounts([confirmed(null)])).toEqual({ people: 1, signups: 1 })
    expect(computeSignupCounts([confirmed(0)])).toEqual({ people: 1, signups: 1 })
  })

  it('matches the real PRIDE shape (27 teams, 35 people)', () => {
    // 19 solos + 8 pairs = 27 signups, 35 people, plus ignored pendings.
    const regs = [
      ...Array.from({ length: 19 }, () => confirmed(1)),
      ...Array.from({ length: 8 }, () => confirmed(2)),
      { status: 'pending_payment', team: { size: 2 } },
    ]
    expect(computeSignupCounts(regs)).toEqual({ people: 35, signups: 27 })
  })
})

describe('formatSignupSummary', () => {
  it('labels registrations "teams" for races', () => {
    expect(formatSignupSummary([confirmed(2), confirmed(1)], { isRace: true }))
      .toBe('3 people · 2 teams')
  })

  it('labels registrations "signups" for non-race kinds', () => {
    expect(formatSignupSummary([confirmed(2), confirmed(1)], { isRace: false }))
      .toBe('3 people · 2 signups')
  })

  it('uses singular nouns for a single person / single registration', () => {
    expect(formatSignupSummary([confirmed(1)], { isRace: true })).toBe('1 person · 1 team')
    expect(formatSignupSummary([confirmed(1)], { isRace: false })).toBe('1 person · 1 signup')
  })

  it('appends an event-level capacity when provided (attached to the signup count)', () => {
    expect(formatSignupSummary([confirmed(1), confirmed(1)], { isRace: true, capacity: 40 }))
      .toBe('2 people · 2 / 40 teams')
  })

  it('omits capacity when null or non-positive', () => {
    expect(formatSignupSummary([confirmed(1)], { isRace: false, capacity: null })).toBe('1 person · 1 signup')
    expect(formatSignupSummary([confirmed(1)], { isRace: false, capacity: 0 })).toBe('1 person · 1 signup')
  })

  it('handles an empty event', () => {
    expect(formatSignupSummary([], { isRace: false })).toBe('0 people · 0 signups')
  })

  it('people mode puts the cap on the headcount', () => {
    expect(formatSignupSummary([confirmed(2), confirmed(1)], { isRace: true, capacity: 40, mode: 'people' }))
      .toBe('3 / 40 people · 2 teams')
    expect(formatSignupSummary([confirmed(2), confirmed(1)], { isRace: false, capacity: 40, mode: 'people' }))
      .toBe('3 / 40 people · 2 signups')
  })

  it('teams mode puts the cap on the registration count (unchanged default)', () => {
    expect(formatSignupSummary([confirmed(1), confirmed(1)], { isRace: true, capacity: 40, mode: 'teams' }))
      .toBe('2 people · 2 / 40 teams')
  })

  it('shows no cap when capacity is null, in either mode', () => {
    expect(formatSignupSummary([confirmed(2), confirmed(1)], { isRace: true, capacity: null, mode: 'people' }))
      .toBe('3 people · 2 teams')
  })
})

describe('loadForMode', () => {
  it('counts teams (registrations) in teams mode', () => {
    expect(loadForMode([confirmed(2), confirmed(1)], 'teams')).toBe(2)
  })

  it('counts people (sum of sizes) in people mode', () => {
    expect(loadForMode([confirmed(2), confirmed(1)], 'people')).toBe(3)
  })

  it('defaults to teams when mode is missing or unknown', () => {
    expect(loadForMode([confirmed(2), confirmed(1)])).toBe(2)
    expect(loadForMode([confirmed(2), confirmed(1)], 'nonsense')).toBe(2)
  })

  it('ignores non-confirmed registrations in both modes', () => {
    const regs = [confirmed(2), { status: 'cancelled', team: { size: 5 } }]
    expect(loadForMode(regs, 'people')).toBe(2)
    expect(loadForMode(regs, 'teams')).toBe(1)
  })
})

describe('spotsLeft', () => {
  it('returns null for an uncapped wave', () => {
    expect(spotsLeft(null, [confirmed(2)], 'people')).toBeNull()
  })

  it('subtracts the people load in people mode', () => {
    expect(spotsLeft(40, [confirmed(2), confirmed(1)], 'people')).toBe(37)
  })

  it('subtracts the team load in teams mode', () => {
    expect(spotsLeft(40, [confirmed(2), confirmed(1)], 'teams')).toBe(38)
  })

  it('never goes negative', () => {
    expect(spotsLeft(2, [confirmed(2), confirmed(1)], 'people')).toBe(0)
  })
})

describe('wouldFit', () => {
  it('always fits an uncapped wave', () => {
    expect(wouldFit(null, [confirmed(2)], 'people', 8)).toBe(true)
  })

  it('people mode: a team fits only if the whole group fits', () => {
    const regs = [confirmed(2), confirmed(1)] // 3 people
    expect(wouldFit(5, regs, 'people', 2)).toBe(true)  // 3 + 2 = 5
    expect(wouldFit(5, regs, 'people', 3)).toBe(false) // 3 + 3 = 6 > 5
  })

  it('teams mode: a registration adds one team regardless of its size', () => {
    const regs = [confirmed(8), confirmed(8)] // 2 teams
    expect(wouldFit(2, regs, 'teams', 8)).toBe(false) // 2 + 1 > 2
    expect(wouldFit(3, [confirmed(1)], 'teams', 8)).toBe(true) // 1 + 1 <= 3
  })
})

describe('sumWaveCapacity', () => {
  it('sums wave capacities', () => {
    expect(sumWaveCapacity([{ capacity: 40 }, { capacity: 20 }])).toBe(60)
  })

  it('treats any uncapped wave as making the whole event uncapped', () => {
    expect(sumWaveCapacity([{ capacity: 40 }, { capacity: null }])).toBeNull()
  })

  it('returns null for no waves', () => {
    expect(sumWaveCapacity([])).toBeNull()
    expect(sumWaveCapacity(null)).toBeNull()
  })
})
