// MAIL-SPAM.1 — the pure half of spam quarantine: reading Postmark's verdict
// off the payload, and deciding against a per-location threshold.
//
// THE ONE RULE THAT MATTERS HERE IS FAIL OPEN. A payload with no readable
// score is NOT spam. A disabled filter quarantines nothing. A threshold that
// cannot be parsed falls back to the default rather than to zero (which would
// quarantine every email). A lost lead is worse than a spam ticket, so every
// ambiguous input resolves to "file it normally".

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EMAIL_SPAM_THRESHOLD,
  DEFAULT_EMAIL_SPAM_SETTINGS,
  SPAM_SETTINGS_COLUMNS,
  SPAM_RETENTION_DAYS,
  normalizeSpamSettings,
  extractSpamScore,
  classifyInboundSpam,
  spamPurgeCutoff,
} from './email-spam'

describe('extractSpamScore — Postmark SpamScore first, headers as fallback', () => {
  it('reads a numeric SpamScore', () => {
    expect(extractSpamScore({ SpamScore: 7.2 })).toBe(7.2)
    expect(extractSpamScore({ SpamScore: 0 })).toBe(0)
    expect(extractSpamScore({ SpamScore: -1.5 })).toBe(-1.5)
  })

  it('reads a numeric-string SpamScore (Postmark serialises it as a string on some streams)', () => {
    expect(extractSpamScore({ SpamScore: '6.1' })).toBe(6.1)
    expect(extractSpamScore({ SpamScore: ' 3 ' })).toBe(3)
  })

  it('falls back to the X-Spam-Score header when SpamScore is absent', () => {
    expect(extractSpamScore({
      Headers: [{ Name: 'X-Spam-Score', Value: '8.4' }],
    })).toBe(8.4)
    // Header names are case-insensitive.
    expect(extractSpamScore({
      Headers: [{ Name: 'x-spam-score', Value: '2.0' }],
    })).toBe(2)
  })

  it('parses score=N out of X-Spam-Status when neither SpamScore nor X-Spam-Score is present', () => {
    expect(extractSpamScore({
      Headers: [{ Name: 'X-Spam-Status', Value: 'Yes, score=9.3 required=5.0 tests=BAYES_99,HTML_MESSAGE' }],
    })).toBe(9.3)
    expect(extractSpamScore({
      Headers: [{ Name: 'X-Spam-Status', Value: 'No, score=-0.2 required=5.0' }],
    })).toBe(-0.2)
  })

  it('SpamScore wins over the headers when both are present', () => {
    expect(extractSpamScore({
      SpamScore: 1.0,
      Headers: [{ Name: 'X-Spam-Score', Value: '9.9' }],
    })).toBe(1)
  })

  it('is null — never 0 — when nothing usable is there (fail open)', () => {
    expect(extractSpamScore({})).toBeNull()
    expect(extractSpamScore(null)).toBeNull()
    expect(extractSpamScore({ SpamScore: 'high' })).toBeNull()
    expect(extractSpamScore({ SpamScore: null, Headers: [] })).toBeNull()
    expect(extractSpamScore({ Headers: [{ Name: 'X-Spam-Status', Value: 'Yes' }] })).toBeNull()
    expect(extractSpamScore({ Headers: 'not-an-array' })).toBeNull()
  })
})

describe('normalizeSpamSettings — per-field fallback to the defaults', () => {
  it('defaults to enabled at 5.0', () => {
    expect(DEFAULT_EMAIL_SPAM_THRESHOLD).toBe(5)
    expect(DEFAULT_EMAIL_SPAM_SETTINGS).toEqual({ enabled: true, threshold: 5 })
    expect(normalizeSpamSettings(null)).toEqual({ enabled: true, threshold: 5 })
    expect(normalizeSpamSettings(undefined)).toEqual({ enabled: true, threshold: 5 })
    expect(normalizeSpamSettings({})).toEqual({ enabled: true, threshold: 5 })
  })

  it('reads the company_settings column shape', () => {
    expect(SPAM_SETTINGS_COLUMNS).toEqual({
      enabled: 'email_spam_filter_enabled',
      threshold: 'email_spam_threshold',
    })
    expect(normalizeSpamSettings({
      email_spam_filter_enabled: false,
      email_spam_threshold: 8,
    })).toEqual({ enabled: false, threshold: 8 })
    // numeric columns come back as strings from PostgREST
    expect(normalizeSpamSettings({ email_spam_threshold: '7.5' })).toEqual({ enabled: true, threshold: 7.5 })
  })

  it('reads the camelCase client shape too', () => {
    expect(normalizeSpamSettings({ enabled: false, threshold: 3 })).toEqual({ enabled: false, threshold: 3 })
  })

  it('a half-written row falls back per FIELD, and junk never becomes 0', () => {
    expect(normalizeSpamSettings({ email_spam_filter_enabled: false })).toEqual({ enabled: false, threshold: 5 })
    expect(normalizeSpamSettings({ email_spam_threshold: 'lots' })).toEqual({ enabled: true, threshold: 5 })
    expect(normalizeSpamSettings({ email_spam_threshold: NaN })).toEqual({ enabled: true, threshold: 5 })
    expect(normalizeSpamSettings({ email_spam_threshold: -3 })).toEqual({ enabled: true, threshold: 5 })
    expect(normalizeSpamSettings({ email_spam_threshold: 99 })).toEqual({ enabled: true, threshold: 5 })
  })
})

describe('classifyInboundSpam', () => {
  it('score ≥ threshold is spam', () => {
    expect(classifyInboundSpam({ score: 5, settings: null })).toMatchObject({ isSpam: true, score: 5, threshold: 5 })
    expect(classifyInboundSpam({ score: 12.7, settings: null }).isSpam).toBe(true)
  })

  it('score < threshold is not spam', () => {
    expect(classifyInboundSpam({ score: 4.9, settings: null })).toMatchObject({ isSpam: false, score: 4.9 })
    expect(classifyInboundSpam({ score: -2, settings: null }).isSpam).toBe(false)
  })

  it('🔴 a missing score is NOT spam — fail open', () => {
    expect(classifyInboundSpam({ score: null, settings: null })).toMatchObject({ isSpam: false, score: null })
    expect(classifyInboundSpam({ score: undefined, settings: null }).isSpam).toBe(false)
    expect(classifyInboundSpam({ score: NaN, settings: null }).isSpam).toBe(false)
  })

  it('respects the per-location threshold', () => {
    const settings = { email_spam_threshold: 8 }
    expect(classifyInboundSpam({ score: 6, settings }).isSpam).toBe(false)
    expect(classifyInboundSpam({ score: 8, settings }).isSpam).toBe(true)
    expect(classifyInboundSpam({ score: 6, settings: {} }).isSpam).toBe(true) // default 5.0
  })

  it('a disabled filter quarantines nothing, whatever the score', () => {
    expect(classifyInboundSpam({ score: 99, settings: { email_spam_filter_enabled: false } }))
      .toMatchObject({ isSpam: false, score: 99, enabled: false })
  })
})

describe('spamPurgeCutoff', () => {
  it('is 30 days before now', () => {
    expect(SPAM_RETENTION_DAYS).toBe(30)
    const now = Date.parse('2026-09-05T10:00:00Z')
    expect(spamPurgeCutoff(now)).toBe('2026-08-06T10:00:00.000Z')
  })
})
