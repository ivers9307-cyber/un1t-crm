// CREDITWINDOW.1 — the last day a Glofox promo plan's credits can book.
import { describe, it, expect, vi } from 'vitest'
import { creditLastDay, readPromoCreditLastDay, withinCreditWindow } from './glofox-credit-window'

const DUB = 'Europe/Dublin'
const plan = (expiry, startsOn = 'PURCHASE_DATE', extra = {}) => ({
  code: 1762508130342, starts_on: startsOn,
  credits: [{ active: true, num_sessions: 7, expiry, ...extra }],
})

describe('creditLastDay', () => {
  it('one week from the purchase day ends six days later (Glofox: active 21/11, expires 27/11)', () => {
    expect(creditLastDay(plan({ interval: 'week', interval_count: 1 }), '2026-11-21')).toBe('2026-11-27')
  })

  it('counts days, weeks and months', () => {
    expect(creditLastDay(plan({ interval: 'day', interval_count: 3 }), '2026-11-21')).toBe('2026-11-23')
    expect(creditLastDay(plan({ interval: 'week', interval_count: 2 }), '2026-11-21')).toBe('2026-12-04')
    expect(creditLastDay(plan({ interval: 'month', interval_count: 1 }), '2026-11-21')).toBe('2026-12-20')
    expect(creditLastDay(plan({ interval: 'month', interval_count: 1 }), '2027-01-31')).toBe('2027-02-27')
  })

  it('takes the shortest of several active credit lines and ignores inactive ones', () => {
    const p = { starts_on: 'PURCHASE_DATE', credits: [
      { active: true, expiry: { interval: 'week', interval_count: 2 } },
      { active: true, expiry: { interval: 'week', interval_count: 1 } },
      { active: false, expiry: { interval: 'day', interval_count: 1 } },
    ] }
    expect(creditLastDay(p, '2026-11-21')).toBe('2026-11-27')
  })

  it('is unknown (null) for anything it cannot judge', () => {
    expect(creditLastDay(plan({ interval: 'week', interval_count: 1 }, 'FIRST_BOOKING_DATE'), '2026-11-21')).toBeNull()
    expect(creditLastDay(plan(null), '2026-11-21')).toBeNull()
    expect(creditLastDay(plan({ interval: 'fortnight', interval_count: 1 }), '2026-11-21')).toBeNull()
    expect(creditLastDay(plan({ interval: 'week', interval_count: 0 }), '2026-11-21')).toBeNull()
    expect(creditLastDay({ starts_on: 'PURCHASE_DATE', credits: [] }, '2026-11-21')).toBeNull()
    expect(creditLastDay(null, '2026-11-21')).toBeNull()
    expect(creditLastDay(plan({ interval: 'week', interval_count: 1 }), 'yesterday')).toBeNull()
    // One line unreadable: no cap, rather than a cap from the other line.
    const mixed = { starts_on: 'PURCHASE_DATE', credits: [
      { active: true, expiry: { interval: 'week', interval_count: 1 } },
      { active: true, expiry: null },
    ] }
    expect(creditLastDay(mixed, '2026-11-21')).toBeNull()
  })
})

describe('withinCreditWindow', () => {
  it('keeps every class when the last day is unknown', () => {
    expect(withinCreditWindow({ day: '2030-01-01' }, null)).toBe(true)
  })
  it('keeps a class on or before the last day and drops a later one', () => {
    expect(withinCreditWindow({ day: '2026-11-27' }, '2026-11-27')).toBe(true)
    expect(withinCreditWindow({ day: '2026-11-28' }, '2026-11-27')).toBe(false)
  })
})

describe('readPromoCreditLastDay', () => {
  const PROMO = { key: 'stillorgan-open-week', platform: 'glofox', glofox: { membershipId: 'm1', planCode: '1762508130342', planName: 'Open Week' } }
  const NOW = new Date('2026-11-21T15:59:00Z')
  const dbWith = (result) => {
    const q = { select: vi.fn(() => q), eq: vi.fn(() => q), maybeSingle: vi.fn(async () => result) }
    return { from: vi.fn(() => q), q }
  }
  const run = (db, promo = PROMO) => readPromoCreditLastDay(db, { locationId: 'L', promo, zone: DUB, now: NOW })

  it('reads the bound plan from the studio catalogue and answers its last day', async () => {
    const db = dbWith({ data: { plans: [plan({ interval: 'week', interval_count: 1 })] }, error: null })
    expect(await run(db)).toBe('2026-11-27')
    expect(db.from).toHaveBeenCalledWith('glofox_memberships')
    expect(db.q.eq).toHaveBeenCalledWith('glofox_membership_id', 'm1')
    expect(db.q.eq).toHaveBeenCalledWith('location_id', 'L')
  })

  it('uses the studio day, not the UTC day', async () => {
    const db = dbWith({ data: { plans: [plan({ interval: 'week', interval_count: 1 })] }, error: null })
    // 23:30 UTC on 30 June is already 1 July in Dublin.
    expect(await readPromoCreditLastDay(db, { locationId: 'L', promo: PROMO, zone: DUB, now: new Date('2026-06-30T23:30:00Z') })).toBe('2026-07-07')
  })

  it('is null without a query for a promo that is not on Glofox or has no plan', async () => {
    const db = dbWith({ data: null, error: null })
    expect(await run(db, { key: 'hatch', platform: 'un1t_online', glofox: null })).toBeNull()
    expect(await run(db, { key: 'x', platform: 'glofox', glofox: null })).toBeNull()
    expect(db.from).not.toHaveBeenCalled()
  })

  it('is null (no cap) when the catalogue cannot answer', async () => {
    expect(await run(dbWith({ data: null, error: { code: 'XX' } }))).toBeNull()
    expect(await run(dbWith({ data: null, error: null }))).toBeNull()
    expect(await run(dbWith({ data: { plans: [{ ...plan({ interval: 'week', interval_count: 1 }), code: 999 }] }, error: null }))).toBeNull()
    expect(await run({ from: () => { throw new Error('boom') } })).toBeNull()
  })
})
