// Tests for the toSlug helper. Used by /api/admin/organizations
// for org slug derivation; also referenced inline in LocationForm
// for location slug derivation. Pinning the contract here means
// any callers can rely on consistent behaviour.

import { describe, it, expect } from 'vitest'
import { toSlug } from './slug'

describe('toSlug', () => {
  it('lowercases', () => {
    expect(toSlug('Hello')).toBe('hello')
    expect(toSlug('UN1T')).toBe('un1t')
  })

  it('replaces spaces with hyphens', () => {
    expect(toSlug('UN1T Group')).toBe('un1t-group')
    expect(toSlug('CCF Autos')).toBe('ccf-autos')
  })

  it('collapses runs of non-alphanumerics into a single hyphen', () => {
    expect(toSlug('hello   world')).toBe('hello-world')
    expect(toSlug('a__b!!c')).toBe('a-b-c')
  })

  it('strips leading and trailing hyphens', () => {
    expect(toSlug('  Hello   ')).toBe('hello')
    expect(toSlug('!@#hello#@!')).toBe('hello')
  })

  it('strips non-ASCII characters (no transliteration)', () => {
    expect(toSlug('tëst')).toBe('t-st')
    expect(toSlug('Café')).toBe('caf')
    expect(toSlug('日本')).toBe('')
  })

  it('returns empty string for unusable input', () => {
    expect(toSlug('')).toBe('')
    expect(toSlug('   ')).toBe('')
    expect(toSlug('!!!')).toBe('')
    expect(toSlug(null)).toBe('')
    expect(toSlug(undefined)).toBe('')
    expect(toSlug(42)).toBe('')
  })

  it('preserves digits', () => {
    expect(toSlug('Studio 5')).toBe('studio-5')
    expect(toSlug('2024 Q4')).toBe('2024-q4')
  })

  it('handles already-slug-like input idempotently', () => {
    expect(toSlug('un1t-group')).toBe('un1t-group')
    expect(toSlug('ccf-autos')).toBe('ccf-autos')
  })
})
