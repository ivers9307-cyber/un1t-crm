// RADAR-AGENT Phase 1 — unit tests for account-tool pure helpers.
import { describe, it, expect } from 'vitest'
import {
  identityMatches,
  formatMembership,
  formatNextClass,
  formatRecentAttendance,
  normEmail,
  ACCOUNT_TOOL_NAMES,
} from './account-tools'

describe('identityMatches', () => {
  const contact = { email: 'Jo@Example.com', dob: '1990-05-14', last_name: 'Murphy' }
  it('passes on matching email (case-insensitive)', () => {
    expect(identityMatches(contact, { email: 'jo@example.com' })).toBe(true)
    expect(identityMatches(contact, { email: '  JO@EXAMPLE.COM ' })).toBe(true)
  })
  it('passes on DOB + last name together', () => {
    expect(identityMatches(contact, { date_of_birth: '1990-05-14', last_name: 'murphy' })).toBe(true)
  })
  it('handles an ISO dob value on the contact', () => {
    expect(identityMatches({ ...contact, dob: '1990-05-14T00:00:00.000Z' }, { date_of_birth: '1990-05-14', last_name: 'Murphy' })).toBe(true)
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
})

describe('formatMembership', () => {
  it('maps state to a friendly label + exposes account_active', () => {
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true }))
      .toEqual({ found: true, status: 'active', raw_state: 'active', account_active: true })
    expect(formatMembership({ glofox_membership_state: 'paused', glofox_account_active: true }).status).toBe('paused')
    expect(formatMembership({ glofox_membership_state: 'future', glofox_account_active: false }).status).toMatch(/starting soon/)
  })
  it('falls back to account_active when state is absent', () => {
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: true }).status).toBe('active')
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: false }).status).toBe('not currently active')
  })
  it('includes plan only when present', () => {
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true }).plan).toBeUndefined()
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true, glofox_membership_plan: 'Pay as you go' }).plan).toBe('Pay as you go')
  })
  it('returns not-found for empty / null record', () => {
    expect(formatMembership(null)).toEqual({ found: false })
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: null })).toEqual({ found: false })
  })
})

describe('formatNextClass', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  it('returns the soonest upcoming non-cancelled class', () => {
    const rows = [
      { class_name: 'Later', class_starts_at: '2026-06-03T10:00:00Z', status: 'booked' },
      { class_name: 'Soonest', class_starts_at: '2026-06-01T18:00:00Z', status: 'booked' },
      { class_name: 'Past', class_starts_at: '2026-05-30T10:00:00Z', status: 'booked' },
    ]
    expect(formatNextClass(rows, now)).toEqual({ found: true, class_name: 'Soonest', class_time: '2026-06-01T18:00:00Z' })
  })
  it('skips cancelled classes', () => {
    const rows = [
      { class_name: 'Cancelled', class_starts_at: '2026-06-01T18:00:00Z', status: 'cancelled' },
      { class_name: 'Good', class_starts_at: '2026-06-02T18:00:00Z', status: 'booked' },
    ]
    expect(formatNextClass(rows, now).class_name).toBe('Good')
  })
  it('returns not-found when nothing upcoming', () => {
    expect(formatNextClass([], now)).toEqual({ found: false })
    expect(formatNextClass([{ class_name: 'Past', class_starts_at: '2026-05-01T10:00:00Z', status: 'booked' }], now)).toEqual({ found: false })
  })
})

describe('formatRecentAttendance', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  it('counts attended classes in the last 30 days + last attended date', () => {
    const rows = [
      { class_starts_at: '2026-05-30T08:00:00Z', attended: true, status: 'booked' },
      { class_starts_at: '2026-05-20T08:00:00Z', attended: true, status: 'booked' },
      { class_starts_at: '2026-04-01T08:00:00Z', attended: true, status: 'booked' },  // outside 30d
      { class_starts_at: '2026-05-28T08:00:00Z', attended: false, status: 'booked' },  // no-show, excluded
    ]
    const r = formatRecentAttendance(rows, now)
    expect(r.found).toBe(true)
    expect(r.attended_last_30d).toBe(2)
    expect(r.last_attended).toBe('2026-05-30T08:00:00Z')
  })
  it('returns found:false / zero when no attendance', () => {
    expect(formatRecentAttendance([], now)).toEqual({ found: false, attended_last_30d: 0, last_attended: null, window_days: 30 })
    expect(formatRecentAttendance([{ class_starts_at: '2026-05-30T08:00:00Z', attended: false }], now).found).toBe(false)
  })
})

describe('tool registry', () => {
  it('exposes all four tools', () => {
    expect([...ACCOUNT_TOOL_NAMES].sort()).toEqual(
      ['get_my_membership', 'get_my_next_class', 'get_my_recent_attendance', 'verify_identity']
    )
  })
  it('normEmail lowercases + trims', () => {
    expect(normEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
})
