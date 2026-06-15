import { describe, it, expect } from 'vitest'
import { splitName } from './name-utils.js'

describe('splitName', () => {
  it('splits a two-part name into first + last', () => {
    expect(splitName('Gavin Murphy')).toEqual({ firstName: 'Gavin', lastName: 'Murphy' })
  })

  it('keeps everything after the first token as the last name', () => {
    expect(splitName('Mary Jane Watson')).toEqual({ firstName: 'Mary', lastName: 'Jane Watson' })
  })

  it('returns a null last name for a single-token name', () => {
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: null })
  })

  it('trims and collapses surrounding / repeated whitespace', () => {
    expect(splitName('  Gavin   Murphy  ')).toEqual({ firstName: 'Gavin', lastName: 'Murphy' })
  })

  it('returns both null for empty string', () => {
    expect(splitName('')).toEqual({ firstName: null, lastName: null })
  })

  it('returns both null for whitespace-only input', () => {
    expect(splitName('   ')).toEqual({ firstName: null, lastName: null })
  })

  it('returns both null for null / undefined / non-string', () => {
    expect(splitName(null)).toEqual({ firstName: null, lastName: null })
    expect(splitName(undefined)).toEqual({ firstName: null, lastName: null })
    expect(splitName(42)).toEqual({ firstName: null, lastName: null })
  })
})
