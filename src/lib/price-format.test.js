import { describe, it, expect } from 'vitest'
import { centsToEuros, eurosToCents } from './price-format'

describe('price-format', () => {
  it('centsToEuros formats for display (empty when 0/unset)', () => {
    expect(centsToEuros(2900)).toBe('29')
    expect(centsToEuros(2950)).toBe('29.5')
    expect(centsToEuros(0)).toBe('')
    expect(centsToEuros(null)).toBe('')
    expect(centsToEuros(undefined)).toBe('')
  })
  it('eurosToCents parses input to integer cents (0 for blank/invalid)', () => {
    expect(eurosToCents('29')).toBe(2900)
    expect(eurosToCents('29.50')).toBe(2950)
    expect(eurosToCents('29.999')).toBe(3000)
    expect(eurosToCents('')).toBe(0)
    expect(eurosToCents('abc')).toBe(0)
    expect(eurosToCents('-5')).toBe(0)
  })
})
