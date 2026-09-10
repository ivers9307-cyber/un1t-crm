// src/lib/widget-token.test.js
// WIDGET.1 — pure token helpers. No IO, no db; these are the only place the
// token's shape is decided.

import { describe, it, expect } from 'vitest'
import {
  WIDGET_TOKEN_PREFIX, generateWidgetToken, hashWidgetToken, parseWidgetBearer,
} from './widget-token'

describe('generateWidgetToken', () => {
  it('mints a prefixed token', () => {
    expect(generateWidgetToken().startsWith(WIDGET_TOKEN_PREFIX)).toBe(true)
  })

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateWidgetToken()))
    expect(seen.size).toBe(200)
  })
})

describe('hashWidgetToken', () => {
  it('is stable for the same token', () => {
    const t = generateWidgetToken()
    expect(hashWidgetToken(t)).toBe(hashWidgetToken(t))
  })

  it('differs between tokens', () => {
    expect(hashWidgetToken(generateWidgetToken()))
      .not.toBe(hashWidgetToken(generateWidgetToken()))
  })

  it('returns a 64-char hex digest', () => {
    expect(hashWidgetToken(generateWidgetToken())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses anything without the prefix', () => {
    // A Supabase JWT must never hash to a lookup key — that is what keeps
    // the two credential families from ever being confused for each other.
    expect(hashWidgetToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y')).toBe(null)
    expect(hashWidgetToken('')).toBe(null)
    expect(hashWidgetToken(null)).toBe(null)
    expect(hashWidgetToken(undefined)).toBe(null)
    expect(hashWidgetToken(12345)).toBe(null)
  })
})

describe('parseWidgetBearer', () => {
  it('extracts a widget token', () => {
    const t = generateWidgetToken()
    expect(parseWidgetBearer(`Bearer ${t}`)).toBe(t)
  })

  it('is case-insensitive on the scheme and tolerates padding', () => {
    const t = generateWidgetToken()
    expect(parseWidgetBearer(`  bearer   ${t}  `)).toBe(t)
  })

  it('ignores a Supabase JWT', () => {
    expect(parseWidgetBearer('Bearer eyJhbGciOiJIUzI1NiJ9.a.b')).toBe(null)
  })

  it('ignores junk', () => {
    expect(parseWidgetBearer('Basic abc')).toBe(null)
    expect(parseWidgetBearer('Bearer')).toBe(null)
    expect(parseWidgetBearer(null)).toBe(null)
    expect(parseWidgetBearer(undefined)).toBe(null)
  })
})
