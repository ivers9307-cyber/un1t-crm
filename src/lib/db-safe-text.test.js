// EMAIL-INBOUND-POISON.1 — what Postgres cannot hold, stripped before it
// reaches an INSERT.
//
// Two byte classes turn "we received an email" into a 500 on the webhook, on
// EVERY Postmark retry (the payload is identical each time, so the failure is
// deterministic and the retry loop burns to exhaustion):
//   • NUL (\u0000) — Postgres `text` cannot store it at all, and jsonb rejects
//     it too, which is why a NUL-bearing payload could not even DEAD-LETTER.
//   • lone UTF-16 surrogates — unencodable as UTF-8, same insert failure.
// safeAttachmentFilename (email-attachment-quota.js) already strips both for
// filenames; this module is the same guard for message bodies, subjects,
// display names and raw payloads, WITHOUT the filename-specific rules (body
// text keeps its newlines and tabs).

import { describe, it, expect } from 'vitest'
import { sanitizeDbText, sanitizeJsonForDb } from './db-safe-text'

describe('sanitizeDbText', () => {
  it('strips NUL bytes', () => {
    expect(sanitizeDbText('my \u0000direct debit\u0000')).toBe('my direct debit')
  })

  it('strips lone UTF-16 surrogates', () => {
    expect(sanitizeDbText('bad\ud800half')).toBe('badhalf')
    expect(sanitizeDbText('\udfff')).toBe('')
  })

  it('keeps valid surrogate PAIRS (emoji survive)', () => {
    expect(sanitizeDbText('thanks \u{1F64F} for the invoice')).toBe('thanks \u{1F64F} for the invoice')
  })

  it('keeps newlines and tabs — this is body text, not a filename', () => {
    expect(sanitizeDbText('line one\nline two\ttabbed')).toBe('line one\nline two\ttabbed')
  })

  it('a truncation-orphaned surrogate at the end is removed', () => {
    // truncateHtmlBody slices by UTF-16 unit, so a cut can split a valid pair
    // and leave a lone high surrogate at the boundary — sanitise AFTER truncate.
    const cut = '\u{1F64F}'.slice(0, 1)
    expect(sanitizeDbText(`body${cut}`)).toBe('body')
  })

  it('passes non-strings through untouched', () => {
    expect(sanitizeDbText(null)).toBe(null)
    expect(sanitizeDbText(undefined)).toBe(undefined)
    expect(sanitizeDbText(42)).toBe(42)
  })

  it('returns the SAME string when nothing needs stripping', () => {
    const s = 'ordinary text'
    expect(sanitizeDbText(s)).toBe(s)
  })
})

describe('sanitizeJsonForDb', () => {
  it('strips NUL from every string in a nested payload, keys included', () => {
    const out = sanitizeJsonForDb({
      Subject: 'a\u0000b',
      FromFull: { Name: '\u0000Ada', Email: 'a@b.com' },
      Headers: [{ Name: 'X', Value: 'v\ud800' }],
      ['bad\u0000key']: 1,
    })
    expect(out).toEqual({
      Subject: 'ab',
      FromFull: { Name: 'Ada', Email: 'a@b.com' },
      Headers: [{ Name: 'X', Value: 'v' }],
      badkey: 1,
    })
  })

  it('leaves numbers, booleans and null alone', () => {
    expect(sanitizeJsonForDb({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null })
  })
})
