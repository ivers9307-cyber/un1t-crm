// UN1TCOMP.1 — the complimentary-credit rules the contact-page form and the
// staff route share: the limits, the reasons, and the use-by maths on the
// STUDIO's clock. Tested in Europe/Dublin and America/New_York across a DST
// change (CLAUDE.md, "Timezones").
import { describe, it, expect } from 'vitest'
import {
  COMP_CREDIT_LIMITS,
  COMP_CREDIT_REASONS,
  COMP_CREDIT_REASON_KEYS,
  compReasonLabel,
  compUseByBounds,
  compDaysUntil,
  compQuickPick,
  formatUseBy,
  compSummary,
  compNoteProblem,
  compCreditsPhrase,
  isDateKey,
} from './un1t-comp-credits.js'

const DUBLIN = 'Europe/Dublin'
const NEW_YORK = 'America/New_York'
const ms = (iso) => Date.parse(iso)

describe('the fixed lists', () => {
  it('limits: 1 to 10 credits, 1 to 365 days, a 200-character note', () => {
    expect(COMP_CREDIT_LIMITS).toEqual({ minCredits: 1, maxCredits: 10, minDays: 1, maxDays: 365, noteMax: 200 })
  })
  it('the five reasons Richard approved, in order', () => {
    expect(COMP_CREDIT_REASONS.map((r) => r.label)).toEqual(['Goodwill', 'Injury', 'Class cancelled by us', 'Referral reward', 'Other'])
    expect(COMP_CREDIT_REASON_KEYS).toEqual(['goodwill', 'injury', 'class_cancelled', 'referral_reward', 'other'])
    expect(compReasonLabel('class_cancelled')).toBe('Class cancelled by us')
    expect(compReasonLabel('nope')).toBe('Other')
  })
})

describe('isDateKey', () => {
  it('a real calendar day only', () => {
    expect(isDateKey('2026-11-05')).toBe(true)
    expect(isDateKey('2026-02-30')).toBe(false)
    expect(isDateKey('2026-11-5')).toBe(false)
    expect(isDateKey(null)).toBe(false)
  })
})

describe('the use-by window is on the studio clock', () => {
  it('Dublin, late on the night the clocks go back (Sun 25 Oct 2026, 23:30 local = 23:30Z): today is the 25th', () => {
    const now = ms('2026-10-25T23:30:00Z')
    expect(compUseByBounds(DUBLIN, now)).toEqual({ today: '2026-10-25', min: '2026-10-26', max: '2027-10-25' })
    expect(compDaysUntil('2026-10-26', DUBLIN, now)).toBe(1)
    expect(compDaysUntil('2026-11-01', DUBLIN, now)).toBe(7)
  })

  it('the same instant in New York is still the 25th (19:30 EDT), and after its own change (1 Nov) the count is calendar days, not 24h blocks', () => {
    const now = ms('2026-10-25T23:30:00Z')
    expect(compUseByBounds(NEW_YORK, now).today).toBe('2026-10-25')
    const nyNight = ms('2026-11-01T03:30:00Z') // 23:30 EDT on Sat 31 Oct, before NY falls back
    expect(compUseByBounds(NEW_YORK, nyNight).today).toBe('2026-10-31')
    expect(compUseByBounds(DUBLIN, nyNight).today).toBe('2026-11-01')
    expect(compDaysUntil('2026-11-07', NEW_YORK, nyNight)).toBe(7)
    expect(compDaysUntil('2026-11-07', DUBLIN, nyNight)).toBe(6)
  })

  it('just after midnight in Dublin in summer (00:10 IST = 23:10Z the day before): a UTC today would be wrong', () => {
    const now = ms('2026-07-14T23:10:00Z')
    expect(compUseByBounds(DUBLIN, now).today).toBe('2026-07-15')
    expect(compDaysUntil('2026-07-22', DUBLIN, now)).toBe(7)
  })

  it('today, the past and an unreadable date are not days ahead', () => {
    const now = ms('2026-10-28T12:00:00Z')
    expect(compDaysUntil('2026-10-28', DUBLIN, now)).toBe(0)
    expect(compDaysUntil('2026-10-20', DUBLIN, now)).toBe(-8)
    expect(compDaysUntil('bad', DUBLIN, now)).toBeNull()
  })
})

describe('quick picks', () => {
  const now = ms('2026-10-28T12:00:00Z')
  it('1 week, 2 weeks and 1 month from the studio day', () => {
    expect(compQuickPick('week', DUBLIN, now)).toBe('2026-11-04')
    expect(compQuickPick('two_weeks', DUBLIN, now)).toBe('2026-11-11')
    expect(compQuickPick('month', DUBLIN, now)).toBe('2026-11-28')
  })
  it('a month from 31 January lands on the last day of February', () => {
    expect(compQuickPick('month', DUBLIN, ms('2027-01-31T12:00:00Z'))).toBe('2027-02-28')
  })
  it('an unknown pick is null', () => {
    expect(compQuickPick('year', DUBLIN, now)).toBeNull()
  })
})

describe('the words', () => {
  it('formats a date key as a day, never through a zone', () => {
    expect(formatUseBy('2026-11-05')).toBe('Thu 5 Nov')
    expect(formatUseBy('2027-02-28')).toBe('Sun 28 Feb')
    expect(formatUseBy('x')).toBe('')
  })
  it('credits phrase, singular and plural', () => {
    expect(compCreditsPhrase(1)).toBe('1 complimentary credit')
    expect(compCreditsPhrase(3)).toBe('3 complimentary credits')
  })
  it('the live summary line', () => {
    const now = ms('2026-10-28T12:00:00Z')
    expect(compSummary({ amount: 2, useBy: '2026-11-05', zone: DUBLIN, nowMs: now }))
      .toBe('Adds 2 credits in un1t.online, usable until Thu 5 Nov (8 days).')
    expect(compSummary({ amount: 1, useBy: '2026-10-29', zone: DUBLIN, nowMs: now }))
      .toBe('Adds 1 credit in un1t.online, usable until Thu 29 Oct (1 day).')
    expect(compSummary({ amount: 1, useBy: '2026-10-28', zone: DUBLIN, nowMs: now })).toBeNull()
  })
})

describe('the team note', () => {
  it('plain text up to 200 characters, never an email or a phone number', () => {
    expect(compNoteProblem('')).toBeNull()
    expect(compNoteProblem('Missed two classes after the Tuesday cancellation')).toBeNull()
    expect(compNoteProblem('x'.repeat(201))).toMatch(/200/)
    expect(compNoteProblem('ask jo@example.com')).toMatch(/email/)
    expect(compNoteProblem('rang 087 123 4567')).toMatch(/phone/)
    expect(compNoteProblem('+353871234567')).toMatch(/phone/)
    expect(compNoteProblem('booked 3 classes in 2026')).toBeNull()
    expect(compNoteProblem('<b>hi</b>')).toMatch(/plain/)
  })
})
