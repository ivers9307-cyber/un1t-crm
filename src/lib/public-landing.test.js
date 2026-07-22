import { describe, it, expect } from 'vitest'
import { resolveLandingPath } from './public-landing'

describe('resolveLandingPath', () => {
  it('defaults to stillorgan when the param is absent', () => {
    expect(resolveLandingPath(null)).toBe('stillorgan')
    expect(resolveLandingPath(undefined)).toBe('stillorgan')
  })

  it('defaults to stillorgan for an empty/whitespace param', () => {
    expect(resolveLandingPath('')).toBe('stillorgan')
    expect(resolveLandingPath('   ')).toBe('stillorgan')
  })

  it('trims and lowercases a provided path', () => {
    expect(resolveLandingPath('  Hatch-Street ')).toBe('hatch-street')
  })

  it('passes a normal slug through unchanged', () => {
    expect(resolveLandingPath('stillorgan')).toBe('stillorgan')
  })

  it('strips characters outside the slug charset and caps length', () => {
    expect(resolveLandingPath('bad/../path')).toBe('badpath')
    expect(resolveLandingPath('a'.repeat(200))).toHaveLength(64)
  })

  it('falls back to stillorgan if sanitising empties the string', () => {
    expect(resolveLandingPath('/// ')).toBe('stillorgan')
  })
})
