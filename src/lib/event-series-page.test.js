// HOSTSERIES.1 — the pure halves of /event/series/<slug>: operator copy with
// defaults, and the cards (published upcoming dates only; a sold-out or
// closed date is shown, never linked to buy).
import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { seriesPageCopy, seriesCards } = await import('./event-series.js')

const date = (over) => ({
  id: over.id, slug: over.id, name: 'Mobility', kind: 'workshop', race_date: over.race_date, venue_name: 'Studio 1',
  hero_image_url: null, accent_hex: null, capacity_mode: 'people', registration_opens_at: null, registration_closes_at: null,
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2500,
  waves: over.waves || [{ id: 'w', capacity: 10, start_time: '10:00:00' }], registrations: over.registrations || [],
  status: over.status || 'published', active: over.active ?? true,
  ...(over.registration_closes_at ? { registration_closes_at: over.registration_closes_at } : {}),
})

describe('seriesPageCopy', () => {
  it('defaults the headline to the name and the blurb to "Pick a date"', () => {
    expect(seriesPageCopy({ name: 'Monthly Mobility', headline: null, blurb: null })).toEqual({ headline: 'Monthly Mobility', blurb: 'Pick a date' })
    expect(seriesPageCopy({ name: 'Monthly Mobility', headline: '  Every month  ', blurb: 'Come along' })).toEqual({ headline: 'Every month', blurb: 'Come along' })
  })
})

describe('seriesCards', () => {
  const now = Date.parse('2026-12-01T10:00:00Z')
  it('lists only published upcoming dates, in date order, linking to /event/<slug>', () => {
    const cards = seriesCards([
      date({ id: 'b', race_date: '2027-02-06' }),
      date({ id: 'a', race_date: '2027-01-02' }),
      date({ id: 'draft', race_date: '2027-03-06', status: 'draft' }),
      date({ id: 'past', race_date: '2026-11-01' }),
      date({ id: 'off', race_date: '2027-04-03', active: false }),
    ], { now, zone: 'Europe/Dublin', today: '2026-12-01' })
    expect(cards.map((c) => c.slug)).toEqual(['a', 'b'])
    expect(cards[0]).toMatchObject({ title: 'Mobility', priceLabel: expect.stringMatching(/25/), badge: null, closed: false, href: '/event/a' })
  })
  it('a full date is badged Sold out and a closed one Registration closed, with no buy link', () => {
    const full = date({ id: 'full', race_date: '2027-01-02', waves: [{ id: 'w', capacity: 1, start_time: '10:00:00' }], registrations: [{ status: 'confirmed', wave_id: 'w', looking_for_team: false, team: { size: 1 } }] })
    const closed = date({ id: 'closed', race_date: '2027-01-09', registration_closes_at: '2026-11-30T00:00:00Z' })
    const cards = seriesCards([full, closed], { now, zone: 'Europe/Dublin', today: '2026-12-01' })
    expect(cards[0]).toMatchObject({ badge: 'Sold out', href: '/event/full' })
    expect(cards[1]).toMatchObject({ badge: 'Registration closed', closed: true, href: null })
  })
  it('is empty for no dates', () => {
    expect(seriesCards([], { now, zone: 'Europe/Dublin', today: '2026-12-01' })).toEqual([])
  })
})
