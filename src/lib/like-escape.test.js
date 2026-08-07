// Tests for the ILIKE-escaping helper and the test-support ILIKE evaluator
// (the 2026-08-07 wildcard bug — see src/lib/like-escape.js).

import { describe, it, expect } from 'vitest'
import { escapeLikePattern } from './like-escape'
import { ilikeMatches } from './like-escape.test-helpers'

describe('escapeLikePattern', () => {
  it('escapes the LIKE wildcards', () => {
    expect(escapeLikePattern('jo_smith@example.com')).toBe('jo\\_smith@example.com')
    expect(escapeLikePattern('%')).toBe('\\%')
    expect(escapeLikePattern('%@example.com')).toBe('\\%@example.com')
  })

  it('escapes the escape character itself, and does not double-escape', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    // The backslash pass must run with the wildcards in ONE regex, not as a
    // second .replace() — otherwise the `\` introduced for `_` gets re-escaped.
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
  })

  it('leaves ordinary addresses untouched', () => {
    expect(escapeLikePattern('plain@example.com')).toBe('plain@example.com')
    expect(escapeLikePattern('first.last+tag@sub.example.co.uk'))
      .toBe('first.last+tag@sub.example.co.uk')
  })

  it('collapses nullish input to an empty string rather than "null"', () => {
    expect(escapeLikePattern(null)).toBe('')
    expect(escapeLikePattern(undefined)).toBe('')
  })
})

describe('ilikeMatches (test-support evaluator)', () => {
  it('models the wildcards Postgres actually applies', () => {
    expect(ilikeMatches('a_b@example.com', 'axb@example.com')).toBe(true)
    expect(ilikeMatches('%@example.com', 'anyone@example.com')).toBe(true)
    expect(ilikeMatches('%@%.%', 'anyone@anywhere.com')).toBe(true)
  })

  it('is case-insensitive, and anchored at both ends', () => {
    expect(ilikeMatches('Sam@Example.com', 'sam@example.com')).toBe(true)
    expect(ilikeMatches('sam@example.com', 'notsam@example.com')).toBe(false)
    expect(ilikeMatches('sam@example.com', 'sam@example.com.evil')).toBe(false)
  })

  it('treats escaped metacharacters as literals', () => {
    expect(ilikeMatches('a\\_b@example.com', 'axb@example.com')).toBe(false)
    expect(ilikeMatches('a\\_b@example.com', 'a_b@example.com')).toBe(true)
    expect(ilikeMatches('\\%@example.com', 'anyone@example.com')).toBe(false)
    expect(ilikeMatches('\\%@example.com', '%@example.com')).toBe(true)
  })

  it('does not let regex metacharacters in the value leak into the pattern', () => {
    // '.' is a regex wildcard but an ordinary LIKE character.
    expect(ilikeMatches('a.b@example.com', 'axb@example.com')).toBe(false)
    expect(ilikeMatches('a+b@example.com', 'a+b@example.com')).toBe(true)
  })
})

describe('escape ∘ ilike is exactly case-insensitive equality', () => {
  // The property the call sites rely on: once escaped, ILIKE means `=` under
  // lower(). Anything that breaks this breaks a lookup somewhere.
  const values = [
    'plain@example.com', 'a_b@example.com', '%@example.com', 'a\\b@example.com',
    'first.last+tag@example.co.uk', 'MiXeD@Example.COM', '%@%.%', '_@example.com',
  ]
  for (const pattern of values) {
    for (const value of values) {
      const expected = pattern.toLowerCase() === value.toLowerCase()
      it(`${JSON.stringify(pattern)} vs ${JSON.stringify(value)} → ${expected}`, () => {
        expect(ilikeMatches(escapeLikePattern(pattern), value)).toBe(expected)
      })
    }
  }
})
