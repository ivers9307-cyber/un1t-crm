// EMAIL-HYGIENE.1 — engagement-based list hygiene (docs/EMAIL_DELIVERABILITY.md:
// "Suppress addresses that haven't opened in 90 days"). These tests pin the
// sweep predicate: a contact is suppressed ONLY when every condition holds —
// consented, not already suppressed (both enforced upstream in the contacts
// scan), ≥ HYGIENE_MIN_MARKETING_SENDS marketing sends inside the window,
// ZERO opens and ZERO clicks inside the window, and a first send OLDER than
// the window (never punish new contacts whose whole history is recent).
import { describe, it, expect } from 'vitest'
import {
  HYGIENE_WINDOW_DAYS,
  HYGIENE_MIN_MARKETING_SENDS,
  hygieneCutoffIso,
  computeSuppressionCandidates,
} from './email-hygiene.js'

describe('hygiene thresholds (conservative by design)', () => {
  it('window is 90 days per docs/EMAIL_DELIVERABILITY.md', () => {
    expect(HYGIENE_WINDOW_DAYS).toBe(90)
  })
  it('requires at least 3 marketing sends in the window (one ignored email is not a dead address)', () => {
    expect(HYGIENE_MIN_MARKETING_SENDS).toBe(3)
  })
  it('hygieneCutoffIso is exactly WINDOW days before now', () => {
    const now = new Date('2026-07-10T00:00:00.000Z')
    expect(hygieneCutoffIso(now)).toBe('2026-04-11T00:00:00.000Z')
  })
})

describe('computeSuppressionCandidates', () => {
  const base = {
    contactIds: ['c1'],
    windowSends: [{ contact_id: 'c1' }, { contact_id: 'c1' }, { contact_id: 'c1' }],
    engagedIds: new Set(),
    preWindowSenderIds: new Set(['c1']),
  }

  it('suppresses when all conditions hold (>=3 window sends, zero engagement, first send pre-window)', () => {
    expect(computeSuppressionCandidates(base)).toEqual(['c1'])
  })

  it('exactly the threshold count of sends qualifies (>= not >)', () => {
    expect(base.windowSends).toHaveLength(HYGIENE_MIN_MARKETING_SENDS)
    expect(computeSuppressionCandidates(base)).toEqual(['c1'])
  })

  it('fewer than the threshold sends → not suppressed', () => {
    expect(computeSuppressionCandidates({
      ...base,
      windowSends: [{ contact_id: 'c1' }, { contact_id: 'c1' }],
    })).toEqual([])
  })

  it('any engagement (open OR click) in the window rescues the contact', () => {
    expect(computeSuppressionCandidates({
      ...base,
      engagedIds: new Set(['c1']),
    })).toEqual([])
  })

  it('no send before the window (new contact) → not suppressed', () => {
    expect(computeSuppressionCandidates({
      ...base,
      preWindowSenderIds: new Set(),
    })).toEqual([])
  })

  it('sends to OTHER contacts never count toward this contact', () => {
    expect(computeSuppressionCandidates({
      ...base,
      windowSends: [
        { contact_id: 'c1' },
        { contact_id: 'c2' }, { contact_id: 'c2' }, { contact_id: 'c2' },
      ],
    })).toEqual([])
  })

  it('evaluates each contact independently and preserves input order', () => {
    const out = computeSuppressionCandidates({
      contactIds: ['a', 'b', 'c', 'd'],
      windowSends: [
        // a: 3 sends, dead → suppress
        { contact_id: 'a' }, { contact_id: 'a' }, { contact_id: 'a' },
        // b: 3 sends but engaged → keep
        { contact_id: 'b' }, { contact_id: 'b' }, { contact_id: 'b' },
        // c: only 1 send → keep
        { contact_id: 'c' },
        // d: 4 sends, dead → suppress
        { contact_id: 'd' }, { contact_id: 'd' }, { contact_id: 'd' }, { contact_id: 'd' },
      ],
      engagedIds: new Set(['b']),
      preWindowSenderIds: new Set(['a', 'b', 'c', 'd']),
    })
    expect(out).toEqual(['a', 'd'])
  })

  it('empty inputs → empty output (safe on a quiet database)', () => {
    expect(computeSuppressionCandidates({
      contactIds: [],
      windowSends: [],
      engagedIds: new Set(),
      preWindowSenderIds: new Set(),
    })).toEqual([])
  })
})
