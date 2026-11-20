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
  it('prices a matching quantity at the option', () => {
    expect(priceForQuantity(RAFFLE, 3)).toEqual({ cents: 1000, label: '3 for €10' })
    expect(priceForQuantity(RAFFLE, 10)).toEqual({ cents: 2050, label: '10 for €20.50' })
    expect(priceForQuantity(RAFFLE, 1)).toEqual({ cents: 500, label: null })
    expect(priceForQuantity({ ticket_price_cents: 500 }, 2)).toEqual({ cents: 1000, label: null })
  })
  it('builds any other number from the cheapest mix of deals and singles', () => {
    // The live charity raffle's prices: two 5-packs (€24) beat the 10-pack
    // (€25), so the mix never uses the 10-pack. Never overcharge.
    const LIVE = { ticket_price_cents: 500, ticket_options: [{ tickets: 5, price_cents: 1200 }, { tickets: 10, price_cents: 2500 }] }
    expect(priceForQuantity(LIVE, 20)).toEqual({ cents: 4800, label: '4 × 5 for €12' })
    expect(priceForQuantity(LIVE, 10)).toEqual({ cents: 2400, label: '2 × 5 for €12' })
    expect(priceForQuantity(LIVE, 7)).toEqual({ cents: 2200, label: '5 for €12 + 2 singles' })
    expect(priceForQuantity(LIVE, 3)).toEqual({ cents: 1500, label: null })
    // A 10-pack that is the better deal gets used.
    const BETTER = { ticket_price_cents: 500, ticket_options: [{ tickets: 5, price_cents: 1200 }, { tickets: 10, price_cents: 2000 }] }
    expect(priceForQuantity(BETTER, 20)).toEqual({ cents: 4000, label: '2 × 10 for €20' })
    expect(priceForQuantity(BETTER, 15)).toEqual({ cents: 3200, label: '10 for €20 + 5 for €12' })
    expect(priceForQuantity(RAFFLE, 4)).toEqual({ cents: 1500, label: '3 for €10 + 1 single' })
    expect(priceForQuantity(RAFFLE, 6)).toEqual({ cents: 2000, label: '2 × 3 for €10' })
  })
  it('takes the cheaper of two options for the same count', () => {
    expect(priceForQuantity({ ticket_price_cents: 500, ticket_options: [{ tickets: 3, price_cents: 1200 }, { tickets: 3, price_cents: 1000 }] }, 3).cents).toBe(1000)
  })
})
