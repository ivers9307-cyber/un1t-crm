import { describe, it, expect } from 'vitest'
import { computeCostPerBooking } from './attribution.js'

describe('computeCostPerBooking', () => {
  const spendByAd = { '1': 10, '2': 5, '3': 0 }
  const bookingsByAd = { '1': 3, '2': 0 }
  it('divides spend by attributed bookings per ad', () => {
    const rows = computeCostPerBooking(spendByAd, bookingsByAd)
    expect(rows['1']).toEqual({ spend: 10, bookings: 3, cpa: 3.33 })
    expect(rows['2']).toEqual({ spend: 5, bookings: 0, cpa: null }) // no bookings → null, not Infinity
    expect(rows['3']).toEqual({ spend: 0, bookings: 0, cpa: null })
  })
})
