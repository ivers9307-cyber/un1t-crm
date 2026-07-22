import { describe, it, expect } from 'vitest'
import { formatMoneyMinor } from './money-format'

describe('formatMoneyMinor', () => {
  it('formats EUR with the € symbol, trimming trailing zeros', () => {
    expect(formatMoneyMinor(2900, 'EUR')).toBe('€29')
    expect(formatMoneyMinor(2950, 'EUR')).toBe('€29.50')
  })
  it('defaults to EUR', () => {
    expect(formatMoneyMinor(1000)).toBe('€10')
  })
  it('supports GBP', () => {
    expect(formatMoneyMinor(1000, 'GBP')).toBe('£10')
  })
  it('falls back to a currency code for unknown currencies', () => {
    expect(formatMoneyMinor(1000, 'USD')).toBe('USD 10.00')
  })
  it('handles 0 / invalid as an empty string', () => {
    expect(formatMoneyMinor(0)).toBe('')
    expect(formatMoneyMinor(null)).toBe('')
    expect(formatMoneyMinor('x')).toBe('')
  })
})
