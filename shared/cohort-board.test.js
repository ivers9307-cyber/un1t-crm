import { describe, it, expect } from 'vitest'
import {
  COHORT_WINDOW_DAYS,
  MIN_COHORT_BOARD,
  isNewMember,
  cohortContactIds,
  applyMinSize,
} from './cohort-board.js'

const DAY = 24 * 3600 * 1000
// Fixed "now" so day-boundary maths is deterministic.
const NOW = new Date('2026-07-03T12:00:00Z').getTime()
// joined_at exactly N whole days before NOW.
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString()

describe('constants', () => {
  it('COHORT_WINDOW_DAYS = 90', () => { expect(COHORT_WINDOW_DAYS).toBe(90) })
  it('MIN_COHORT_BOARD = 3', () => { expect(MIN_COHORT_BOARD).toBe(3) })
})

describe('isNewMember', () => {
  it('absent joinedAt → false', () => {
    expect(isNewMember(null, NOW)).toBe(false)
    expect(isNewMember(undefined, NOW)).toBe(false)
    expect(isNewMember('', NOW)).toBe(false)
  })
  it('garbage joinedAt → false', () => {
    expect(isNewMember('garbage', NOW)).toBe(false)
    expect(isNewMember('not-a-date', NOW)).toBe(false)
    expect(isNewMember({}, NOW)).toBe(false)
  })
  it('future joinedAt → true (treated as brand-new)', () => {
    expect(isNewMember(daysAgo(-1), NOW)).toBe(true)
    expect(isNewMember(new Date(NOW + 10 * DAY).toISOString(), NOW)).toBe(true)
  })
  it('day 89 → in the window', () => {
    expect(isNewMember(daysAgo(89), NOW, 90)).toBe(true)
  })
  it('day 90 → in the window (inclusive boundary)', () => {
    expect(isNewMember(daysAgo(90), NOW, 90)).toBe(true)
  })
  it('day 91 → out of the window', () => {
    expect(isNewMember(daysAgo(91), NOW, 90)).toBe(false)
  })
  it('defaults windowDays to COHORT_WINDOW_DAYS', () => {
    expect(isNewMember(daysAgo(89), NOW)).toBe(true)
    expect(isNewMember(daysAgo(91), NOW)).toBe(false)
  })
  it('accepts a ms number and a Date object', () => {
    expect(isNewMember(NOW - 10 * DAY, NOW)).toBe(true)
    expect(isNewMember(new Date(NOW - 10 * DAY), NOW)).toBe(true)
    expect(isNewMember(NOW - 200 * DAY, NOW)).toBe(false)
  })
  it('honours a custom windowDays', () => {
    expect(isNewMember(daysAgo(30), NOW, 42)).toBe(true)
    expect(isNewMember(daysAgo(43), NOW, 42)).toBe(false)
  })
})

describe('cohortContactIds', () => {
  it('returns ids that are new AND not opted out', () => {
    const contacts = [
      { id: 'new-in', joined_at: daysAgo(10) },
      { id: 'new-boundary', joined_at: daysAgo(90) },
      { id: 'old-out', joined_at: daysAgo(200) },
      { id: 'new-optout', joined_at: daysAgo(5), hr_leaderboard_opt_out: true },
      { id: 'no-join' },
    ]
    const set = cohortContactIds(contacts, NOW, 90)
    expect(set).toBeInstanceOf(Set)
    expect([...set].sort()).toEqual(['new-boundary', 'new-in'])
  })
  it('excludes opted-out members by construction (never on the board)', () => {
    const contacts = [{ id: 'a', joined_at: daysAgo(1), hr_leaderboard_opt_out: true }]
    expect(cohortContactIds(contacts, NOW, 90).has('a')).toBe(false)
  })
  it('includes future joiners, excludes garbage/absent join dates', () => {
    const contacts = [
      { id: 'future', joined_at: daysAgo(-3) },
      { id: 'garbage', joined_at: 'nope' },
      { id: 'absent' },
    ]
    const set = cohortContactIds(contacts, NOW, 90)
    expect(set.has('future')).toBe(true)
    expect(set.has('garbage')).toBe(false)
    expect(set.has('absent')).toBe(false)
  })
  it('empty / nullish input → empty set', () => {
    expect(cohortContactIds([], NOW, 90).size).toBe(0)
    expect(cohortContactIds(null, NOW, 90).size).toBe(0)
    expect(cohortContactIds(undefined, NOW, 90).size).toBe(0)
  })
  it('defaults windowDays to COHORT_WINDOW_DAYS', () => {
    const contacts = [
      { id: 'in', joined_at: daysAgo(89) },
      { id: 'out', joined_at: daysAgo(91) },
    ]
    const set = cohortContactIds(contacts, NOW)
    expect(set.has('in')).toBe(true)
    expect(set.has('out')).toBe(false)
  })
})

describe('applyMinSize', () => {
  it('tooSmall when fewer than minSize rows', () => {
    const rows = [{ rank: 1 }, { rank: 2 }]
    expect(applyMinSize(rows, 3)).toEqual({ rows, tooSmall: true })
  })
  it('not tooSmall at exactly minSize rows', () => {
    const rows = [{ rank: 1 }, { rank: 2 }, { rank: 3 }]
    expect(applyMinSize(rows, 3)).toEqual({ rows, tooSmall: false })
  })
  it('not tooSmall above minSize', () => {
    const rows = [{ rank: 1 }, { rank: 2 }, { rank: 3 }, { rank: 4 }]
    expect(applyMinSize(rows, 3).tooSmall).toBe(false)
  })
  it('defaults minSize to MIN_COHORT_BOARD', () => {
    expect(applyMinSize([{ rank: 1 }, { rank: 2 }]).tooSmall).toBe(true)
    expect(applyMinSize([{ rank: 1 }, { rank: 2 }, { rank: 3 }]).tooSmall).toBe(false)
  })
  it('nullish rows → empty rows + tooSmall', () => {
    expect(applyMinSize(null, 3)).toEqual({ rows: [], tooSmall: true })
    expect(applyMinSize(undefined)).toEqual({ rows: [], tooSmall: true })
  })
})
