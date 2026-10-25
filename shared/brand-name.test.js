import { describe, it, expect } from 'vitest'
import { productName, pointsUnit, PLATFORM_NAME } from './brand-name.js'

describe('brand-name (W1.B1)', () => {
  it('builds {Brand} Points and {Brand} HR', () => {
    expect(productName('UN1T', 'points')).toBe('UN1T Points')
    expect(productName('Gym A', 'hr')).toBe('Gym A HR')
  })
  it('with no brand the product name is the bare noun, never a literal gym', () => {
    expect(productName('', 'points')).toBe('Points')
    expect(productName(null, 'hr')).toBe('HR')
  })
  it('trims the brand and refuses an unknown kind', () => {
    expect(productName('  Gym A  ', 'points')).toBe('Gym A Points')
    expect(() => productName('Gym A', 'credits')).toThrow(/unknown kind/)
  })
  it('the short unit is the brand itself, or "pts"', () => {
    expect(pointsUnit('UN1T')).toBe('UN1T')
    expect(pointsUnit('')).toBe('pts')
  })
  it('the platform name is Repset', () => { expect(PLATFORM_NAME).toBe('Repset') })
})
