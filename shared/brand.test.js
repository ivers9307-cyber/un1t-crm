import { describe, it, expect } from 'vitest'
import { SUPPORT_EMAIL } from './brand.js'

describe('SUPPORT_EMAIL', () => {
  it('defaults to the champ fitness support address', () => {
    expect(SUPPORT_EMAIL).toBe('hello@champfitness.ie')
  })
})
