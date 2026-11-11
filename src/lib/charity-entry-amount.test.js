import { describe, it, expect } from 'vitest'
import {
  resolveEntryAmountSettings, validateEntryAmount, priceRaceAtChosenAmount, eurosToCents,
  ENTRY_AMOUNT_DEFAULT_MIN_CENTS, ENTRY_AMOUNT_MAX_CENTS,
} from './charity-entry-amount'
import { computeTeamPricing } from './member-validation'

const race = (over = {}) => ({
  kind: 'race',
  charity_enabled: true,
  charity: { entry_choose_amount: true, entry_min_cents: 2000 },
  non_member_fee_cents: 5000,
  ...over,
})

describe('resolveEntryAmountSettings', () => {
  it('is on with the ticket price as the suggestion', () => {
    expect(resolveEntryAmountSettings(race())).toEqual({ enabled: true, min_cents: 2000, max_cents: ENTRY_AMOUNT_MAX_CENTS, suggested_cents: 5000 })
  })
  it('is off when Charity day is off, the switch is off, or the event is lead_gen', () => {
    expect(resolveEntryAmountSettings(race({ charity_enabled: false })).enabled).toBe(false)
    expect(resolveEntryAmountSettings(race({ charity: { entry_min_cents: 2000 } })).enabled).toBe(false)
    expect(resolveEntryAmountSettings(race({ kind: 'lead_gen' })).enabled).toBe(false)
    expect(resolveEntryAmountSettings({}).enabled).toBe(false)
  })
  it('defaults the minimum and lifts a suggestion below it', () => {
    const s = resolveEntryAmountSettings(race({ charity: { entry_choose_amount: true }, non_member_fee_cents: 100 }))
    expect(s.min_cents).toBe(ENTRY_AMOUNT_DEFAULT_MIN_CENTS)
    expect(s.suggested_cents).toBe(ENTRY_AMOUNT_DEFAULT_MIN_CENTS)
  })
  it('suggests the minimum on a free event', () => {
    expect(resolveEntryAmountSettings(race({ non_member_fee_cents: null })).suggested_cents).toBe(2000)
  })
})

describe('validateEntryAmount', () => {
  const s = resolveEntryAmountSettings(race())
  it('accepts an amount in range', () => {
    expect(validateEntryAmount(s, 2000)).toEqual({ ok: true, cents: 2000 })
    expect(validateEntryAmount(s, 12345)).toEqual({ ok: true, cents: 12345 })
  })
  it('refuses below the minimum, above the maximum, and junk', () => {
    expect(validateEntryAmount(s, 1999)).toMatchObject({ ok: false, error: expect.stringContaining('€20.00') })
    expect(validateEntryAmount(s, ENTRY_AMOUNT_MAX_CENTS + 1).ok).toBe(false)
    expect(validateEntryAmount(s, 12.5).ok).toBe(false)
    expect(validateEntryAmount(s, undefined).ok).toBe(false)
    expect(validateEntryAmount({ enabled: false }, 5000).ok).toBe(false)
  })
})

describe('priceRaceAtChosenAmount', () => {
  it('charges every person the chosen amount, member pricing off', () => {
    const priced = priceRaceAtChosenAmount(race({ member_pricing_enabled: true, member_fee_cents: 1000 }), 3000)
    const p = computeTeamPricing({ validatedRoster: [{ is_member: true }, { is_member: false }], race: priced })
    expect(p.total_cents).toBe(6000)
    expect(p.non_member_fee_cents).toBe(3000)
    expect(p.member_fee_cents).toBeNull()
  })
})

describe('eurosToCents', () => {
  it('reads euros with a dot or a comma', () => {
    expect(eurosToCents('50')).toBe(5000)
    expect(eurosToCents('12.5')).toBe(1250)
    expect(eurosToCents('12,34')).toBe(1234)
    expect(eurosToCents(' 7 ')).toBe(700)
  })
  it('refuses junk, zero and three decimals', () => {
    for (const v of ['', 'abc', '0', '-5', '1.234', null, undefined]) expect(eurosToCents(v)).toBeNull()
  })
})

describe('movePriceGapCents with a choose-your-amount event (CHARITYENTRY.1)', () => {
  it('is 0 when either side lets entrants choose', async () => {
    const { movePriceGapCents: computePriceGapCents } = await import('./registration-move')
    const fixed = { non_member_fee_cents: 2000 }
    expect(computePriceGapCents({ sourceEvent: race(), targetEvent: fixed, headcount: 2 })).toBe(0)
    expect(computePriceGapCents({ sourceEvent: fixed, targetEvent: race(), headcount: 2 })).toBe(0)
    expect(computePriceGapCents({ sourceEvent: fixed, targetEvent: { non_member_fee_cents: 5000 }, headcount: 2 })).toBe(6000)
  })
})
