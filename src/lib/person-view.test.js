import { describe, it, expect } from 'vitest'
import { initials, accountStatusLabel, accountStatusTone, formatLastSeen } from './person-view'

// ─── initials ─────────────────────────────────────────────────────────────

describe('initials', () => {
  it('returns two uppercase initials from a two-word name', () => {
    expect(initials('Aoife Byrne')).toBe('AB')
  })
  it('returns the first initial only from a one-word name', () => {
    expect(initials('aoife')).toBe('A')
  })
  it('uppercases initials regardless of input case', () => {
    expect(initials('john smith')).toBe('JS')
  })
  it('uses first + last word for names with more than two parts', () => {
    expect(initials('Mary Jane Watson')).toBe('MW')
  })
  it('returns ? for null', () => {
    expect(initials(null)).toBe('?')
  })
  it('returns ? for undefined', () => {
    expect(initials(undefined)).toBe('?')
  })
  it('returns ? for empty string', () => {
    expect(initials('')).toBe('?')
  })
  it('returns ? for whitespace-only string', () => {
    expect(initials('   ')).toBe('?')
  })
  it('handles extra internal whitespace', () => {
    expect(initials('  Aoife   Byrne  ')).toBe('AB')
  })
})

// ─── accountStatusLabel ───────────────────────────────────────────────────

describe('accountStatusLabel', () => {
  it('maps classpass_payg to ClassPass', () => {
    expect(accountStatusLabel('classpass_payg')).toBe('ClassPass')
  })
  it('maps member to Member', () => {
    expect(accountStatusLabel('member')).toBe('Member')
  })
  it('maps credit_member to Credit member', () => {
    expect(accountStatusLabel('credit_member')).toBe('Credit member')
  })
  it('maps trial to Trial', () => {
    expect(accountStatusLabel('trial')).toBe('Trial')
  })
  it('maps lead to Lead', () => {
    expect(accountStatusLabel('lead')).toBe('Lead')
  })
  it('maps ex_member to Ex-member', () => {
    expect(accountStatusLabel('ex_member')).toBe('Ex-member')
  })
  it('title-cases unknown values (replacing underscores)', () => {
    expect(accountStatusLabel('some_unknown_status')).toBe('Some Unknown Status')
  })
  it('returns Unknown for null', () => {
    expect(accountStatusLabel(null)).toBe('Unknown')
  })
  it('returns Unknown for undefined', () => {
    expect(accountStatusLabel(undefined)).toBe('Unknown')
  })
  it('returns Unknown for empty string', () => {
    expect(accountStatusLabel('')).toBe('Unknown')
  })
})

// ─── formatLastSeen ───────────────────────────────────────────────────────

describe('formatLastSeen', () => {
  it('formats an ISO datetime string as a short human date', () => {
    // 12 Jun 2026 — use a midday UTC time so timezone offsets don't shift the date
    expect(formatLastSeen('2026-06-12T12:00:00.000Z')).toBe('12 Jun 2026')
  })
  it('formats a date-only ISO string', () => {
    expect(formatLastSeen('2026-01-05T12:00:00.000Z')).toBe('5 Jan 2026')
  })
  it('returns Never for null', () => {
    expect(formatLastSeen(null)).toBe('Never')
  })
  it('returns Never for undefined', () => {
    expect(formatLastSeen(undefined)).toBe('Never')
  })
  it('returns Never for empty string', () => {
    expect(formatLastSeen('')).toBe('Never')
  })
  it('returns Never for an invalid date string', () => {
    expect(formatLastSeen('not-a-date')).toBe('Never')
  })
})

// ─── accountStatusTone ────────────────────────────────────────────────────

describe('accountStatusTone', () => {
  it('returns emerald tone for member', () => {
    const cls = accountStatusTone('member')
    expect(cls).toContain('emerald-700')
  })
  it('returns emerald tone for credit_member', () => {
    const cls = accountStatusTone('credit_member')
    expect(cls).toContain('emerald-700')
  })
  it('returns blue tone for classpass_payg', () => {
    const cls = accountStatusTone('classpass_payg')
    expect(cls).toContain('blue-700')
  })
  it('returns amber tone for trial', () => {
    const cls = accountStatusTone('trial')
    expect(cls).toContain('amber-700')
  })
  it('returns red tone for ex_member', () => {
    const cls = accountStatusTone('ex_member')
    expect(cls).toContain('red-700')
  })
  it('returns slate tone for unknown status', () => {
    const cls = accountStatusTone('some_unknown')
    expect(cls).toContain('slate-700')
  })
  it('returns slate tone for null', () => {
    const cls = accountStatusTone(null)
    expect(cls).toContain('slate-700')
  })
  it('returns slate tone for undefined', () => {
    const cls = accountStatusTone(undefined)
    expect(cls).toContain('slate-700')
  })
  it('returns class strings, not hex values', () => {
    const cls = accountStatusTone('member')
    expect(cls).not.toMatch(/#[0-9a-fA-F]{3,6}/)
  })
  it('always includes a background and text class', () => {
    for (const s of ['member', 'credit_member', 'classpass_payg', 'trial', 'lead', 'cold', 'ex_member', null]) {
      const cls = accountStatusTone(s)
      expect(cls).toMatch(/bg-/)
      expect(cls).toMatch(/text-/)
    }
  })
})
