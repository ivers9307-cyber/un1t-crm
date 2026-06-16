// Tests for the /events signup-summary helpers. Pure, Node env.

import { describe, it, expect } from 'vitest'
import { computeSignupCounts, formatSignupSummary } from './event-signups.js'

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
})
