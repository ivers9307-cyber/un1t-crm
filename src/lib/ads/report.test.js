// src/lib/ads/report.test.js
import { describe, it, expect } from 'vitest'
import { buildAdReportEmail, buildCallout } from './report.js'

describe('buildCallout', () => {
  it('names the cheapest booking and the biggest spender-without-bookings', () => {
    const perAd = [
      { name: 'schedule-fit', spend: 5, bookings: 2, cpa: 2.5 },
      { name: 'testimonial', spend: 10, bookings: 0, cpa: null },
    ]
    const line = buildCallout(perAd)
    expect(line).toMatch(/schedule-fit/)
    expect(line).toMatch(/testimonial/)
  })
})

describe('buildAdReportEmail', () => {
  it('builds subject with spend, bookings and blended CPA', () => {
    const { subject, html } = buildAdReportEmail({
      locationName: 'UN1T Stillorgan', date: '2026-07-04',
      kpis: { spend: 10, bookings: 3, cpa: 3.33 },
      perAd: [{ name: 'schedule-fit', spend: 5, bookings: 2, cpa: 2.5, ctr: 2.5 }],
    })
    expect(subject).toContain('UN1T Stillorgan')
    expect(subject).toContain('€10')
    expect(subject).toContain('3 booked')
    expect(html).toContain('schedule-fit')
  })
})
