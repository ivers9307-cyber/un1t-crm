import { describe, it, expect } from 'vitest'
import {
  intervalMonths, computeMrr, summariseCancels, computeEngagement,
  computeFloor, computeActivation, bookingOutcome, windowBounds, windowDelta, WINDOW_DAYS,
} from './studio-kpi-math.js'

describe('intervalMonths', () => {
  it('parses the live Glofox interval strings', () => {
    expect(intervalMonths('1 month')).toBe(1)
    expect(intervalMonths('3 months')).toBe(3)
    expect(intervalMonths('6 months')).toBe(6)
    expect(intervalMonths('12 months')).toBe(12)
  })
  it('is unit-aware, matching churn-radar monthlyValueCents', () => {
    expect(intervalMonths('1 year')).toBe(12)
    expect(intervalMonths('2 weeks')).toBeCloseTo(2 * (12 / 52))
    expect(intervalMonths('30 days')).toBeCloseTo(1)
  })
  it('falls back to monthly for null / junk', () => {
    expect(intervalMonths(null)).toBe(1)
    expect(intervalMonths('')).toBe(1)
    expect(intervalMonths('weekly')).toBe(1)
    expect(intervalMonths('0 months')).toBe(1)
  })
})

describe('computeMrr', () => {
  it('normalises each price by its billing interval', () => {
    const { mrrCents, recurringMembers, yieldCents } = computeMrr([
      { price_cents: 20000, interval: '1 month' },   // 20000
      { price_cents: 30000, interval: '3 months' },  // 10000
      { price_cents: 120000, interval: '12 months' }, // 10000
    ])
    expect(mrrCents).toBe(40000)
    expect(recurringMembers).toBe(3)
    expect(yieldCents).toBe(13333)
  })
  it('counts zero-price members in the base but not the MRR', () => {
    const { mrrCents, recurringMembers } = computeMrr([
      { price_cents: 0, interval: '1 month' },
      { price_cents: 10000, interval: '1 month' },
    ])
    expect(mrrCents).toBe(10000)
    expect(recurringMembers).toBe(2)
  })
  it('handles an empty base', () => {
    expect(computeMrr([])).toEqual({ mrrCents: 0, recurringMembers: 0, yieldCents: null })
  })
})

describe('summariseCancels', () => {
  const cancelAt = '2026-08-01T00:00:00Z'
  it('splits early vs tenured at 90 days and prices stamped rows', () => {
    const out = summariseCancels([
      { occurred_at: cancelAt, joined_at: '2026-07-01T00:00:00Z', price_cents: 20000, interval: '1 month' },  // 31d — early
      { occurred_at: cancelAt, joined_at: '2025-01-01T00:00:00Z', price_cents: 30000, interval: '3 months' }, // tenured, 10000/mo
    ], 15000)
    expect(out.total).toBe(2)
    expect(out.early).toBe(1)
    expect(out.tenured).toBe(1)
    expect(out.churnCents).toBe(30000)
    expect(out.estimatedCount).toBe(0)
  })
  it('estimates unstamped (pre-mig-480) rows at the avg yield', () => {
    const out = summariseCancels([
      { occurred_at: cancelAt, joined_at: '2025-01-01T00:00:00Z', price_cents: null, interval: null },
    ], 15000)
    expect(out.churnCents).toBe(15000)
    expect(out.estimatedCount).toBe(1)
  })
  it('treats a stamped zero price as real (comp membership) — no estimate', () => {
    const out = summariseCancels([
      { occurred_at: cancelAt, joined_at: '2025-01-01T00:00:00Z', price_cents: 0, interval: '1 month' },
    ], 15000)
    expect(out.churnCents).toBe(0)
    expect(out.estimatedCount).toBe(0)
  })
  it('buckets missing joined_at as unknown tenure', () => {
    const out = summariseCancels([
      { occurred_at: cancelAt, joined_at: null, price_cents: 10000, interval: '1 month' },
    ], 0)
    expect(out.unknownTenure).toBe(1)
    expect(out.early + out.tenured).toBe(0)
  })
})

describe('computeEngagement', () => {
  it('computes active rate and weekly visits per member', () => {
    const out = computeEngagement([
      { total_attended_30d: 8 },
      { total_attended_30d: 0 },
      { total_attended_30d: 4 },
      { total_attended_30d: null },
    ])
    expect(out.members).toBe(4)
    expect(out.activeMembers).toBe(2)
    expect(out.activeRatePct).toBe(50)
    // 12 visits / 4 members / (30/7) weeks = 0.7
    expect(out.visitsPerMemberWeek).toBe(0.7)
  })
  it('nulls out on an empty base', () => {
    expect(computeEngagement([])).toEqual({ members: 0, activeMembers: 0, activeRatePct: null, visitsPerMemberWeek: null })
  })
})

describe('bookingOutcome', () => {
  it('glofox BOOKED attended / not attended, WAITING and CANCELLED excluded', () => {
    expect(bookingOutcome({ source_platform: 'glofox', status: 'BOOKED', attended: true })).toBe('attended')
    expect(bookingOutcome({ source_platform: 'glofox', status: 'BOOKED', attended: false })).toBe('no_show')
    expect(bookingOutcome({ source_platform: 'glofox', status: 'WAITING', attended: false })).toBe('excluded')
    expect(bookingOutcome({ source_platform: 'glofox', status: 'CANCELLED', attended: false })).toBe('excluded')
    expect(bookingOutcome({ source_platform: 'glofox', status: null, attended: false })).toBe('excluded')
    // glofox never reads ATTENDED / NO_SHOW as a verdict
    expect(bookingOutcome({ source_platform: 'glofox', status: 'ATTENDED', attended: true })).toBe('excluded')
  })

  it('a row with no source_platform is read as glofox', () => {
    expect(bookingOutcome({ status: 'BOOKED', attended: true })).toBe('attended')
    expect(bookingOutcome({ status: 'BOOKED', attended: false })).toBe('no_show')
    expect(bookingOutcome({ status: 'CANCELLED', attended: false })).toBe('excluded')
  })

  it('un1t_online ATTENDED, NO_SHOW, BOOKED undecided, CANCELLED excluded', () => {
    const u = (status, attended = false) => bookingOutcome({ source_platform: 'un1t_online', status, attended })
    expect(u('ATTENDED', true)).toBe('attended')
    expect(u('NO_SHOW')).toBe('no_show')
    // the boolean does not decide a un1t row: BOOKED is undecided either way
    expect(u('BOOKED', false)).toBe('undecided')
    expect(u('BOOKED', true)).toBe('undecided')
    expect(u('CANCELLED')).toBe('excluded')
    expect(u('WAITING')).toBe('excluded')
    expect(u(null)).toBe('excluded')
  })
})

describe('computeFloor', () => {
  const occurrences = [
    { glofox_event_id: 'e1', instructor: 'Aoife', capacity: 20, booked: 18, starts_at: '2026-08-03T06:00:00Z' },
    { glofox_event_id: 'e2', instructor: 'Aoife', capacity: 20, booked: 10, starts_at: '2026-07-10T06:00:00Z' },
    { glofox_event_id: 'e3', instructor: 'Brian', capacity: null, booked: 12, starts_at: '2026-07-11T06:00:00Z' },
  ]
  const bookings = [
    { glofox_event_id: 'e1', status: 'BOOKED', attended: true },
    { glofox_event_id: 'e1', status: 'BOOKED', attended: false },
    { glofox_event_id: 'e2', status: 'BOOKED', attended: true },
    { glofox_event_id: 'e2', status: 'CANCELED', attended: false },
    { glofox_event_id: 'e3', status: 'BOOKED', attended: true },
  ]
  it('computes fill (capacity-known classes only), no-show, per-coach', () => {
    const out = computeFloor(occurrences, bookings, { sevenDayCutIso: '2026-08-01T00:00:00Z' })
    expect(out.classes).toBe(3)
    expect(out.fillPct).toBe(70)      // (18+10)/(20+20)
    expect(out.fillPct7d).toBe(90)    // 18/20
    expect(out.noShowPct).toBe(25)    // 1 of 4 BOOKED
    expect(out.attendedVisits).toBe(3)
    expect(out.groupedBy).toBe('coach')
    const aoife = out.groupTable.find(c => c.label === 'Aoife')
    expect(aoife.classes).toBe(2)
    expect(aoife.fillPct).toBe(70)
    expect(aoife.noShowPct).toBe(33)  // 1 of 3
    const brian = out.groupTable.find(c => c.label === 'Brian')
    expect(brian.fillPct).toBe(null)  // no capacity data
    expect(brian.noShowPct).toBe(0)
  })
  it('falls back to per-class grouping when no occurrence has an instructor', () => {
    const occs = occurrences.map(o => ({ ...o, instructor: null, name: o.glofox_event_id === 'e3' ? 'HYROX' : 'STRENGTH' }))
    const out = computeFloor(occs, bookings, {})
    expect(out.groupedBy).toBe('class')
    const strength = out.groupTable.find(g => g.label === 'STRENGTH')
    expect(strength.classes).toBe(2)
    expect(strength.fillPct).toBe(70)
    expect(out.groupTable.find(g => g.label === 'HYROX').classes).toBe(1)
  })
  it('ignores phantom bookings whose class was cancelled or is outside the window', () => {
    const withPhantom = [...bookings,
      { glofox_event_id: 'cancelled-class', status: 'BOOKED', attended: false },
      { glofox_event_id: 'cancelled-class', status: 'BOOKED', attended: false },
    ]
    const out = computeFloor(occurrences, withPhantom, {})
    expect(out.noShowPct).toBe(25)   // unchanged — phantoms excluded
    expect(out.attendedVisits).toBe(3)
  })
  it('un1t past BOOKED rows leave numerator and denominator; all undecided gives noShowPct null and per-group noShowPct null', () => {
    const occs = [
      { glofox_event_id: 'u1', name: 'HYROX', capacity: 10, booked: 6, starts_at: '2026-08-03T06:00:00Z' },
    ]
    const un1t = (status, attended = false) => ({ glofox_event_id: 'u1', source_platform: 'un1t_online', status, attended })
    const allUndecided = computeFloor(occs, [un1t('BOOKED'), un1t('BOOKED'), un1t('CANCELLED')], {})
    expect(allUndecided.noShowPct).toBe(null)
    expect(allUndecided.groupTable[0].noShowPct).toBe(null)

    // 1 attended, 1 no-show, 2 undecided: the undecided two are in neither side
    const mixed = computeFloor(occs, [un1t('ATTENDED', true), un1t('NO_SHOW'), un1t('BOOKED'), un1t('BOOKED')], {})
    expect(mixed.noShowPct).toBe(50)
    expect(mixed.attendedVisits).toBe(1)
    expect(mixed.groupTable[0].noShowPct).toBe(50)
  })
  it('counts glofox and un1t rows side by side without moving the glofox rate', () => {
    const occs = [
      { glofox_event_id: 'g1', name: 'A', capacity: 10, booked: 4, starts_at: '2026-08-03T06:00:00Z' },
    ]
    const rows = [
      { glofox_event_id: 'g1', source_platform: 'glofox', status: 'BOOKED', attended: true },
      { glofox_event_id: 'g1', source_platform: 'glofox', status: 'BOOKED', attended: false },
      { glofox_event_id: 'g1', source_platform: 'un1t_online', status: 'BOOKED', attended: false },
    ]
    const out = computeFloor(occs, rows, {})
    expect(out.noShowPct).toBe(50)
    expect(out.attendedVisits).toBe(1)
  })
  it('nulls rates when there is no data', () => {
    const out = computeFloor([], [])
    expect(out.fillPct).toBe(null)
    expect(out.noShowPct).toBe(null)
    expect(out.groupTable).toEqual([])
  })
})

describe('computeActivation', () => {
  const now = Date.parse('2026-08-04T12:00:00Z')
  it('counts only complete windows and requires 3 attended visits in 14 days', () => {
    const joiners = [
      { id: 'a', joined_at: '2026-07-01T00:00:00Z' },  // complete, 3 visits → activated
      { id: 'b', joined_at: '2026-07-01T00:00:00Z' },  // complete, 1 visit → not
      { id: 'c', joined_at: '2026-08-01T00:00:00Z' },  // window still open → pending
    ]
    const mk = (cid, day) => ({ contact_id: cid, starts_at: `2026-07-${day}T06:00:00Z`, status: 'BOOKED', attended: true })
    const bookings = [
      mk('a', '02'), mk('a', '05'), mk('a', '09'),
      mk('b', '02'),
      // visit outside a's 14-day window — must not count
      { contact_id: 'a', starts_at: '2026-07-20T06:00:00Z', status: 'BOOKED', attended: true },
      // no-show — must not count
      { contact_id: 'b', starts_at: '2026-07-03T06:00:00Z', status: 'BOOKED', attended: false },
    ]
    const out = computeActivation(joiners, bookings, now)
    expect(out.cohort).toBe(2)
    expect(out.pending).toBe(1)
    expect(out.activatedPct).toBe(50)
  })
  it('counts a un1t ATTENDED as a visit, never a un1t BOOKED', () => {
    const joiners = [{ id: 'a', joined_at: '2026-07-01T00:00:00Z' }]
    const row = (status, attended, day) => ({
      contact_id: 'a', source_platform: 'un1t_online', starts_at: `2026-07-${day}T06:00:00Z`, status, attended,
    })
    const three = [row('ATTENDED', true, '02'), row('ATTENDED', true, '05'), row('ATTENDED', true, '09')]
    expect(computeActivation(joiners, three, now).activatedPct).toBe(100)
    // a past BOOKED is undecided, however the boolean reads
    const withBooked = [row('ATTENDED', true, '02'), row('ATTENDED', true, '05'), row('BOOKED', true, '09')]
    expect(computeActivation(joiners, withBooked, now).activatedPct).toBe(0)
    const noShow = [row('ATTENDED', true, '02'), row('ATTENDED', true, '05'), row('NO_SHOW', false, '09')]
    expect(computeActivation(joiners, noShow, now).activatedPct).toBe(0)
  })
  it('nulls on an empty cohort', () => {
    expect(computeActivation([], [], now).activatedPct).toBe(null)
  })
})

describe('windowBounds', () => {
  const now = new Date('2026-08-04T12:00:00Z')

  it('returns a current window of WINDOW_DAYS ending now', () => {
    const { startIso, endIso, days } = windowBounds(now)
    expect(days).toBe(WINDOW_DAYS)
    expect(endIso).toBe(now.toISOString())
    const spanDays = (Date.parse(endIso) - Date.parse(startIso)) / 86_400_000
    expect(spanDays).toBe(WINDOW_DAYS)
  })

  it('makes the previous window the same width, immediately before', () => {
    const { startIso, prevStartIso } = windowBounds(now)
    const prevSpan = (Date.parse(startIso) - Date.parse(prevStartIso)) / 86_400_000
    expect(prevSpan).toBe(WINDOW_DAYS)
  })

  it('honours a custom width', () => {
    const { startIso, endIso } = windowBounds(now, 7)
    expect((Date.parse(endIso) - Date.parse(startIso)) / 86_400_000).toBe(7)
  })
})

describe('windowDelta', () => {
  it('subtracts the previous window', () => {
    expect(windowDelta(10, 6)).toBe(4)
    expect(windowDelta(6, 10)).toBe(-4)
    expect(windowDelta(5, 5)).toBe(0)
  })

  it('is null when either side is unknown, so the UI shows no delta', () => {
    expect(windowDelta(null, 6)).toBe(null)
    expect(windowDelta(10, null)).toBe(null)
    expect(windowDelta(undefined, undefined)).toBe(null)
  })
})
