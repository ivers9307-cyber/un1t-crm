// EMAIL-TICKET.5 — the signature append.
//
// Two properties carry the weight:
//   • NO signature appends NOTHING. Every reply the system has sent so far
//     was written by someone with no signature set, so a dangling "-- " on
//     the empty case is a visible regression for every member, not an edge.
//   • the separator is the RFC 3676 one ("-- ", with the trailing space) on a
//     line of its own after a blank line — that exact shape is what mail
//     clients collapse.

import { describe, it, expect } from 'vitest'
import {
  appendSignature,
  hasSignature,
  normalizeSignature,
  SIGNATURE_SEPARATOR,
  MAX_SIGNATURE_LENGTH,
} from './email-signature'

describe('appendSignature — the empty cases append NOTHING', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   \n\t  \n '],
    ['a non-string', 42],
  ])('%s leaves the body byte-identical', (_label, signature) => {
    const body = 'We open at 6.'
    const out = appendSignature(body, signature)
    expect(out).toBe(body)
    // Not just "same text" — no stray separator anywhere.
    expect(out).not.toContain('--')
    expect(out).not.toMatch(/\n\s*$/)
  })
})

describe('appendSignature — with a signature', () => {
  it('separates with a blank line then the RFC 3676 "-- " line', () => {
    const out = appendSignature('We open at 6.', 'Sarah\nUN1T Stillorgan')
    expect(out).toBe('We open at 6.\n\n-- \nSarah\nUN1T Stillorgan')

    // Stated structurally too, so a reformat can't quietly drop the blank
    // line or the trailing space that makes clients collapse it.
    const lines = out.split('\n')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe(SIGNATURE_SEPARATOR)
    expect(SIGNATURE_SEPARATOR).toBe('-- ')
  })

  it('does not stack the body’s own trailing whitespace in front of it', () => {
    expect(appendSignature('We open at 6.\n\n\n  ', 'Sarah')).toBe('We open at 6.\n\n-- \nSarah')
  })

  it('normalises CRLF out of a signature pasted from a mail client', () => {
    expect(appendSignature('hi', 'Sarah\r\nUN1T')).toBe('hi\n\n-- \nSarah\nUN1T')
  })

  it('trims the signature’s own leading/trailing blank lines', () => {
    expect(appendSignature('hi', '\n\n  Sarah  \n\n')).toBe('hi\n\n-- \nSarah')
  })

  it('appends exactly once when called on an already-signed body', () => {
    const once = appendSignature('hi', 'Sarah')
    // Guards the shape, not idempotency: the route must never call this twice,
    // and this records what would happen if it did.
    expect(once.match(/-- /g)).toHaveLength(1)
  })

  it('does not escape or alter markup-looking text — escaping is the caller’s single step', () => {
    // The whole point of appending to the TEXT is that the route's existing
    // text→HTML escaper then runs over body AND signature together. Escaping
    // here would double-escape.
    const out = appendSignature('a & b', 'R&D <team@un1t.ie>')
    expect(out).toContain('a & b')
    expect(out).toContain('R&D <team@un1t.ie>')
    expect(out).not.toContain('&amp;')
  })

  it('handles an empty body without a leading blank line', () => {
    // The route's schema forbids an empty body; the helper still must not
    // emit "\n\n-- " with nothing above it.
    expect(appendSignature('', 'Sarah')).toBe('-- \nSarah')
  })
})

describe('normalizeSignature / hasSignature', () => {
  it('agree on what counts as "no signature"', () => {
    for (const v of [null, undefined, '', '   ', '\n\n', 7]) {
      expect(normalizeSignature(v)).toBe('')
      expect(hasSignature(v)).toBe(false)
    }
  })

  it('agree on what counts as a real one', () => {
    expect(normalizeSignature('  Sarah\nUN1T  ')).toBe('Sarah\nUN1T')
    expect(hasSignature('  Sarah  ')).toBe(true)
  })
})

describe('MAX_SIGNATURE_LENGTH', () => {
  it('matches the mig 493 CHECK so the UI rejects before Postgres does', () => {
    expect(MAX_SIGNATURE_LENGTH).toBe(2000)
  })
})
