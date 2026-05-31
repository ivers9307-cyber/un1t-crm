// RADAR-AGENT Phase 1 — unit tests for account-tool pure helpers.
import { describe, it, expect } from 'vitest'
import {
  identityMatches,
  formatMembership,
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
  it('handles a Date/ISO dob value on the contact', () => {
    const c = { ...contact, dob: '1990-05-14T00:00:00.000Z' }
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
    expect(identityMatches({ dob: '1990-05-14', last_name: 'Murphy' }, { email: 'jo@example.com' })).toBe(false)
  })
})

describe('formatMembership', () => {
  it('maps state to a friendly label and exposes account_active', () => {
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true }))
      .toEqual({ found: true, status: 'active', raw_state: 'active', account_active: true })
    expect(formatMembership({ glofox_membership_state: 'paused', glofox_account_active: true }).status).toBe('paused')
    expect(formatMembership({ glofox_membership_state: 'cancelled', glofox_account_active: false }).status).toBe('cancelled')
    expect(formatMembership({ glofox_membership_state: 'future', glofox_account_active: false }).status).toMatch(/starting soon/)
  })
  it('falls back to account_active when state is absent', () => {
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: true }).status).toBe('active')
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: false }).status).toBe('not currently active')
  })
  it('only includes a plan when one is present', () => {
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true }).plan).toBeUndefined()
    expect(formatMembership({ glofox_membership_state: 'active', glofox_account_active: true, glofox_membership_plan_full: 'Unlimited' }).plan)
      .toBe('Unlimited')
  })
  it('returns not-found for an empty / null record', () => {
    expect(formatMembership(null)).toEqual({ found: false })
    expect(formatMembership({ glofox_membership_state: null, glofox_account_active: null })).toEqual({ found: false })
  })
})

describe('tool registry', () => {
  it('exposes verify_identity + get_my_membership and NOT next-class', () => {
    expect(ACCOUNT_TOOL_NAMES.has('verify_identity')).toBe(true)
    expect(ACCOUNT_TOOL_NAMES.has('get_my_membership')).toBe(true)
    expect(ACCOUNT_TOOL_NAMES.has('get_my_next_class')).toBe(false)
    expect(ACCOUNT_TOOL_NAMES.size).toBe(2)
  })
  it('normEmail lowercases + trims', () => {
    expect(normEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
})
