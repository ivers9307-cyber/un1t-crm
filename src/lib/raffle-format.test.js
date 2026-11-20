import { describe, it, expect } from 'vitest'
import { formatTicketList, optionLabel, priceForQuantity } from './raffle-format'

const RAFFLE = { ticket_price_cents: 500, ticket_options: [{ tickets: 3, price_cents: 1000 }, { tickets: 10, price_cents: 2050 }] }

describe('raffle ticket options', () => {
  it('lists every number one by one', () => {
    expect(formatTicketList(41, 43)).toBe('#041, #042, #043')
    expect(formatTicketList(7, 7)).toBe('#007')
  })
  it('labels whole and part euros', () => {
    expect(optionLabel(3, 1000)).toBe('3 for €10')
    expect(optionLabel(10, 2050)).toBe('10 for €20.50')
  })
  it('prices a matching quantity at the option, anything else per ticket', () => {
    expect(priceForQuantity(RAFFLE, 3)).toEqual({ cents: 1000, label: '3 for €10' })
    expect(priceForQuantity(RAFFLE, 10)).toEqual({ cents: 2050, label: '10 for €20.50' })
    expect(priceForQuantity(RAFFLE, 1)).toEqual({ cents: 500, label: null })
    expect(priceForQuantity(RAFFLE, 4)).toEqual({ cents: 2000, label: null })
    expect(priceForQuantity({ ticket_price_cents: 500 }, 2)).toEqual({ cents: 1000, label: null })
  })
  it('takes the cheaper of two options for the same count', () => {
    expect(priceForQuantity({ ticket_price_cents: 500, ticket_options: [{ tickets: 3, price_cents: 1200 }, { tickets: 3, price_cents: 1000 }] }, 3).cents).toBe(1000)
  })
})
