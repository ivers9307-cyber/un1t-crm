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

describe('formatNextClass (recent_bookings jsonb shape)', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000)
  it('returns the soonest upcoming non-cancelled class', () => {
    const rows = [
      { event_name: 'Later', time_start: sec('2026-06-03T10:00:00Z'), status: 'BOOKED' },
      { event_name: 'Soonest', time_start: sec('2026-06-01T18:00:00Z'), status: 'BOOKED' },
      { event_name: 'Past', time_start: sec('2026-05-30T10:00:00Z'), status: 'BOOKED' },
    ]
    const r = formatNextClass(rows, now)
    expect(r.found).toBe(true)
    expect(r.class_name).toBe('Soonest')
    expect(r.class_time).toBe('2026-06-01T18:00:00.000Z')
  })
  it('falls back to model_name when event_name absent', () => {
    const rows = [{ model_name: 'RALLY - CONDITIONING', time_start: sec('2026-06-02T18:00:00Z'), status: 'BOOKED' }]
    expect(formatNextClass(rows, now).class_name).toBe('RALLY - CONDITIONING')
  })
  it('skips cancelled classes', () => {
    const rows = [
      { event_name: 'Cancelled', time_start: sec('2026-06-01T18:00:00Z'), status: 'CANCELLED' },
      { event_name: 'Good', time_start: sec('2026-06-02T18:00:00Z'), status: 'BOOKED' },
    ]
    expect(formatNextClass(rows, now).class_name).toBe('Good')
  })
  it('returns not-found when nothing upcoming', () => {
    expect(formatNextClass([], now)).toEqual({ found: false })
    expect(formatNextClass([{ event_name: 'Past', time_start: sec('2026-05-01T10:00:00Z'), status: 'BOOKED' }], now)).toEqual({ found: false })
    expect(formatNextClass(null, now)).toEqual({ found: false })
  })
})

describe('formatRecentAttendance (rollup columns)', () => {
  it('reads the synced rollups off the contact row', () => {
    const r = formatRecentAttendance({ total_attended_30d: 10, total_attended_7d: 2, last_attended_at: '2026-05-23T07:00:00Z' })
    expect(r).toEqual({ found: true, attended_last_30d: 10, attended_last_7d: 2, last_attended: '2026-05-23T07:00:00Z' })
  })
  it('coerces missing counts to 0', () => {
    const r = formatRecentAttendance({ total_attended_30d: null, total_attended_7d: null, last_attended_at: '2026-05-23T07:00:00Z' })
    expect(r).toEqual({ found: true, attended_last_30d: 0, attended_last_7d: 0, last_attended: '2026-05-23T07:00:00Z' })
  })
  it('returns found:false when there is no attendance at all', () => {
    expect(formatRecentAttendance({ total_attended_30d: 0, total_attended_7d: 0, last_attended_at: null })).toEqual({ found: false })
    expect(formatRecentAttendance(null)).toEqual({ found: false })
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
