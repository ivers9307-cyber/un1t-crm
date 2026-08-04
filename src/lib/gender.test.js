import { describe, it, expect } from 'vitest'
import { normaliseGender } from './gender.js'

describe('normaliseGender', () => {
  it('maps the real-world male variants to canonical male', () => {
    for (const v of ['male', 'Male', 'MALE', 'm', 'M', ' male ', ' M ']) {
      expect(normaliseGender(v)).toBe('male')
    }
  })
  it('maps the real-world female variants to canonical female', () => {
    for (const v of ['female', 'Female', 'FEMALE', 'f', 'F', ' female ']) {
      expect(normaliseGender(v)).toBe('female')
    }
  })
  it('returns null for unknown/legacy codes and blanks', () => {
    for (const v of ['P', 'p', 'not_specified', 'other', '', '  ', 'x', 'males']) {
      expect(normaliseGender(v)).toBeNull()
    }
  })
  it('returns null for non-strings', () => {
    for (const v of [null, undefined, 0, 1, true, {}, [], Symbol.for('male')]) {
      expect(normaliseGender(v)).toBeNull()
    }
  })
})
