import { describe, it, expect } from 'vitest'
import { formatEventDate, eventPriceLabel, isEventSoldOut, toBrowseCard } from './public-events.js'

describe('formatEventDate', () => {
  it('formats an ISO date as "Sun 12 Jul" (noon-UTC anchored, TZ-safe)', () => {
    expect(formatEventDate('2026-07-12')).toBe('Sun 12 Jul') // 2026-07-12 is a Sunday
  })
  it('returns empty string for missing date', () => {
    expect(formatEventDate(null)).toBe('')
  })
})

describe('eventPriceLabel', () => {
  it('free when non_member_fee_cents is null', () => {
    expect(eventPriceLabel({ non_member_fee_cents: null })).toBe('Free')
  })
  it('single price when no member pricing', () => {
    expect(eventPriceLabel({ member_pricing_enabled: false, non_member_fee_cents: 2500 })).toBe('€25')
  })
  it('"From €X" (the cheaper of member/non-member) when member pricing on', () => {
    expect(eventPriceLabel({ member_pricing_enabled: true, member_fee_cents: 1500, non_member_fee_cents: 2500 })).toBe('From €15')
  })
  it('drops the .00 but keeps real cents', () => {
    expect(eventPriceLabel({ non_member_fee_cents: 2550 })).toBe('€25.50')
  })
})

describe('isEventSoldOut', () => {
  const wave = (id, capacity) => ({ id, capacity })
  const reg = (wave_id, size = 1, status = 'confirmed') => ({ wave_id, status, team: { size } })

  it('teams mode: all capped waves full, no uncapped → sold out', () => {
    const waves = [wave('w1', 2)]
    const regs = [reg('w1'), reg('w1')]
    expect(isEventSoldOut(waves, regs, 'teams')).toBe(true)
  })
  it('teams mode: a free slot remains → not sold out', () => {
    expect(isEventSoldOut([wave('w1', 2)], [reg('w1')], 'teams')).toBe(false)
  })
  it('people mode: counts team sizes', () => {
    const waves = [wave('w1', 4)]
    const regs = [reg('w1', 2), reg('w1', 2)] // 4 people
    expect(isEventSoldOut(waves, regs, 'people')).toBe(true)
  })
  it('an uncapped wave keeps it open even if capped waves are full', () => {
    const waves = [wave('w1', 1), wave('w2', null)]
    expect(isEventSoldOut(waves, [reg('w1')], 'teams')).toBe(false)
  })
  it('ignores non-confirmed registrations', () => {
    expect(isEventSoldOut([wave('w1', 1)], [reg('w1', 1, 'pending_payment')], 'teams')).toBe(false)
  })
  it('no capped waves → not sold out', () => {
    expect(isEventSoldOut([wave('w1', null)], [], 'teams')).toBe(false)
    expect(isEventSoldOut([], [], 'teams')).toBe(false)
  })
})

describe('toBrowseCard', () => {
  const base = { slug: 'hyrox', name: 'Hyrox Sim', kind: 'race', race_date: '2026-07-12', non_member_fee_cents: 2500 }
  const NOW = Date.parse('2026-07-01T12:00:00Z')

  it('maps the core card fields', () => {
    const c = toBrowseCard(base, { soldOut: false, now: NOW })
    expect(c).toMatchObject({ slug: 'hyrox', title: 'Hyrox Sim', kindLabel: 'Race', dateLabel: 'Sun 12 Jul', priceLabel: '€25', badge: null })
  })
  it('badge "Opens …" when registration_opens_at is in the future', () => {
    const c = toBrowseCard({ ...base, registration_opens_at: '2026-07-05T09:00:00Z' }, { soldOut: false, now: NOW })
    expect(c.badge).toBe('Opens 5 Jul')
  })
  it('badge "Sold out" when soldOut + already open', () => {
    expect(toBrowseCard(base, { soldOut: true, now: NOW }).badge).toBe('Sold out')
  })
  it('"Opens" takes precedence over sold-out', () => {
    const c = toBrowseCard({ ...base, registration_opens_at: '2026-07-05T09:00:00Z' }, { soldOut: true, now: NOW })
    expect(c.badge).toBe('Opens 5 Jul')
  })
})
