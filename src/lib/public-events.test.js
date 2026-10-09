import { describe, it, expect } from 'vitest'
import { formatEventDate, eventPriceLabel, isEventSoldOut, toBrowseCard, formatEventTime } from './public-events.js'

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

describe('formatEventTime (HOST-EVENTS-PAGE.1)', () => {
  it('takes the earliest wave start and drops the seconds', () => {
    expect(formatEventTime({ waves: [{ start_time: '12:30:00' }, { start_time: '11:00:00' }] })).toBe('11:00')
  })
  it('falls back to the event start_time, then empty', () => {
    expect(formatEventTime({ waves: [], start_time: '18:35' })).toBe('18:35')
    expect(formatEventTime({ waves: [] })).toBe('')
    expect(formatEventTime(null)).toBe('')
  })
})

describe('toBrowseCard time + venue (HOST-EVENTS-PAGE.1)', () => {
  it('carries timeLabel and a trimmed venue', () => {
    const c = toBrowseCard({ slug: 'hatch-oct18-1100', name: 'PTC', kind: 'masterclass', race_date: '2026-10-18', venue_name: ' UN1T Hatch Street ', waves: [{ start_time: '11:00:00', capacity: 30 }], non_member_fee_cents: 1500 })
    expect(c.timeLabel).toBe('11:00')
    expect(c.venue).toBe('UN1T Hatch Street')
  })
  it('venue is null when absent', () => {
    expect(toBrowseCard({ slug: 'x', name: 'X', kind: 'race', race_date: '2026-10-18', waves: [] }).venue).toBeNull()
  })
})

describe('toBrowseCard registration closed (HOST-EVENTS-PAGE.2)', () => {
  const base = { slug: 'ptc-oct18', name: 'PTC', kind: 'masterclass', race_date: '2026-10-18', non_member_fee_cents: 1500 }
  const NOW = Date.parse('2026-10-09T12:00:00Z')

  it('badge "Registration closed" and closed=true once registration_closes_at has passed', () => {
    const c = toBrowseCard({ ...base, registration_closes_at: '2026-10-08T18:00:00Z' }, { soldOut: false, now: NOW })
    expect(c.badge).toBe('Registration closed')
    expect(c.closed).toBe(true)
  })
  it('closed wins over sold out (nothing to buy either way)', () => {
    const c = toBrowseCard({ ...base, registration_closes_at: '2026-10-08T18:00:00Z' }, { soldOut: true, now: NOW })
    expect(c.badge).toBe('Registration closed')
  })
  it('an open event is unchanged: no badge, closed=false', () => {
    const c = toBrowseCard({ ...base, registration_closes_at: '2026-10-17T18:00:00Z' }, { soldOut: false, now: NOW })
    expect(c.badge).toBeNull()
    expect(c.closed).toBe(false)
  })
  it('"Opens" still takes precedence; sold-out unchanged while open', () => {
    expect(toBrowseCard({ ...base, registration_opens_at: '2026-10-12T09:00:00Z', registration_closes_at: '2026-10-17T18:00:00Z' }, { now: NOW }).badge).toBe('Opens 12 Oct')
    expect(toBrowseCard(base, { soldOut: true, now: NOW })).toMatchObject({ badge: 'Sold out', closed: false })
  })
})
