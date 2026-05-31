// RADAR-AGENT Phase 1 — unit tests for account-tool pure helpers.
import { describe, it, expect } from 'vitest'
import {
  identityMatches,
  formatMembership,
  formatNextClass,
  normEmail,
  ACCOUNT_TOOL_NAMES,
} from './account-tools'

describe('identityMatches', () => {
  const contact = { email: 'Jo@Example.com', birthday: '1990-05-14', last_name: 'Murphy' }

  it('passes on matching email (case-insensitive)', () => {
    expect(identityMatches(contact, { email: 'jo@example.com' })).toBe(true)
    expect(identityMatches(contact, { email: '  JO@EXAMPLE.COM ' })).toBe(true)
  })
  it('passes on DOB + last name together', () => {
    expect(identityMatches(contact, { date_of_birth: '1990-05-14', last_name: 'murphy' })).toBe(true)
  })
  it('handles a Date/ISO birthday value', () => {
    const c = { ...contact, birthday: '1990-05-14T00:00:00.000Z' }
    expect(identityMatches(c, { date_of_birth: '1990-05-14', last_name: 'Murphy' })).toBe(true)
  })
  it('fails on DOB alone or last name alone', () => {
    expect(identityMatches(contact, { date_of_birth: '1990-05-14' })).toBe(false)
    expect(identityMatches(contact, { last_name: 'Murphy' })).toBe(false)
  })
  it('fails on wrong email / wrong dob', () => {
    expect(identityMatches(contact, { email: 'someone@else.com' })).toBe(false)
    expect(identityMatches(contact, { date_of_birth: '1991-01-01', last_name: 'Murphy' })).toBe(false)
  })
  it('fails on empty inputs / null contact', () => {
    expect(identityMatches(contact, {})).toBe(false)
    expect(identityMatches(null, { email: 'jo@example.com' })).toBe(false)
  })
  it('does not match when the contact has no email but one is provided', () => {
    expect(identityMatches({ birthday: '1990-05-14', last_name: 'Murphy' }, { email: 'jo@example.com' })).toBe(false)
  })
})

describe('formatMembership', () => {
  it('maps states to friendly labels', () => {
    expect(formatMembership({ membership_state: 'member', membership_plan_name_full: 'Unlimited', membership_plan_price: '€89' }))
      .toEqual({ found: true, status: 'active', raw_state: 'member', plan: 'Unlimited', price: '€89' })
    expect(formatMembership({ membership_state: 'paused' }).status).toBe('paused')
    expect(formatMembership({ membership_state: 'cancelled' }).status).toBe('cancelled')
  })
  it('prefers full plan name, falls back to short', () => {
    expect(formatMembership({ membership_state: 'member', membership_plan_name: 'Short' }).plan).toBe('Short')
  })
  it('handles a missing contact', () => {
    expect(formatMembership(null)).toEqual({ found: false })
  })
})

describe('formatNextClass', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  it('returns the soonest upcoming non-cancelled class', () => {
    const rows = [
      { class_name: 'Later', class_time: '2026-06-03T10:00:00Z', status: 'booked' },
      { class_name: 'Soonest', class_time: '2026-06-01T18:00:00Z', status: 'booked' },
      { class_name: 'Past', class_time: '2026-05-30T10:00:00Z', status: 'booked' },
    ]
    expect(formatNextClass(rows, now)).toEqual({ found: true, class_name: 'Soonest', class_time: '2026-06-01T18:00:00Z' })
  })
  it('skips cancelled classes', () => {
    const rows = [
      { class_name: 'Cancelled', class_time: '2026-06-01T18:00:00Z', status: 'cancelled' },
      { class_name: 'Good', class_time: '2026-06-02T18:00:00Z', status: 'booked' },
    ]
    expect(formatNextClass(rows, now).class_name).toBe('Good')
  })
  it('returns not-found when nothing upcoming', () => {
    expect(formatNextClass([], now)).toEqual({ found: false })
    expect(formatNextClass([{ class_name: 'Past', class_time: '2026-05-01T10:00:00Z', status: 'booked' }], now))
      .toEqual({ found: false })
  })
})

describe('tool registry', () => {
  it('exposes the three account tools', () => {
    expect(ACCOUNT_TOOL_NAMES.has('verify_identity')).toBe(true)
    expect(ACCOUNT_TOOL_NAMES.has('get_my_membership')).toBe(true)
    expect(ACCOUNT_TOOL_NAMES.has('get_my_next_class')).toBe(true)
  })
  it('normEmail lowercases + trims', () => {
    expect(normEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
})
