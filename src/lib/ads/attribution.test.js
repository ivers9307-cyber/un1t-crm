import { describe, it, expect } from 'vitest'
import { computeCostPerBooking, resolveAdId } from './attribution.js'

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

describe('resolveAdId', () => {
  const nameToId = { 'testimonial-vicky': '1', 'schedule-fit-45min': '2' }
  it('prefers ad_external_id when present', () => {
    expect(resolveAdId({ ad_external_id: '99', utm_content: 'testimonial-vicky' }, nameToId)).toBe('99')
  })
  it('falls back to utm_content → ad name', () => {
    expect(resolveAdId({ ad_external_id: null, utm_content: 'schedule-fit-45min' }, nameToId)).toBe('2')
  })
  it('returns null when neither resolves', () => {
    expect(resolveAdId({ utm_content: 'unknown-ad' }, nameToId)).toBe(null)
    expect(resolveAdId(null, nameToId)).toBe(null)
    expect(resolveAdId({})).toBe(null)
  })
})
