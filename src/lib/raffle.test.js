import { describe, it, expect } from 'vitest'
import {
  formatTicketNumber, formatTicketRange, phoneDigitsTail, pickRandomIndex,
  publicWinnerName, raffleTotals,
} from './raffle'

describe('raffle helpers', () => {
  it('pads ticket numbers to three digits', () => {
    expect(formatTicketNumber(7)).toBe('#007')
    expect(formatTicketNumber(1234)).toBe('#1234')
  })

  it('shows a single ticket or a run', () => {
    expect(formatTicketRange(41, 41)).toBe('#041')
    expect(formatTicketRange(41, 43)).toBe('#041–#043')
  })

  it('matches Irish phone numbers however they are typed', () => {
    expect(phoneDigitsTail('+353 87 123 4567')).toBe('871234567')
    expect(phoneDigitsTail('087 123 4567')).toBe('871234567')
    expect(phoneDigitsTail('0871234567')).toBe('871234567')
    expect(phoneDigitsTail('12')).toBeNull()
    expect(phoneDigitsTail('sarah')).toBeNull()
  })

  it('picks within range and refuses an empty draw', () => {
    expect(() => pickRandomIndex(0)).toThrow()
    expect(pickRandomIndex(5, () => 3)).toBe(3)
    for (let i = 0; i < 200; i++) {
      const n = pickRandomIndex(3)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(3)
    }
  })

  it('shows a winner as first name and last initial', () => {
    expect(publicWinnerName('Sarah Anne Byrne')).toBe('Sarah B.')
    expect(publicWinnerName('Cher')).toBe('Cher')
    expect(publicWinnerName('')).toBe('')
  })

  it('totals leave out voided sales', () => {
    const t = raffleTotals([
      { quantity: 3, total_cents: 1500, payment_method: 'cash', voided_at: null },
      { quantity: 1, total_cents: 500, payment_method: 'card', voided_at: null },
      { quantity: 10, total_cents: 5000, payment_method: 'cash', voided_at: '2026-11-21T10:00:00Z' },
    ])
    expect(t).toEqual({ cents: 2000, tickets: 4, sales: 2, cashCents: 1500, cardCents: 500 })
  })
})
