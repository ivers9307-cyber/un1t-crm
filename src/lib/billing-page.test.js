// INTEG-D1 — pure-helper tests for the tenant Billing & usage page.

import { describe, it, expect } from 'vitest'
import {
  lastDayOfDublinMonth,
  daysLeftInMonth,
  walletLapseWarning,
  shapeMeterUsage,
  foldRollupsByLocation,
  LAPSE_WARNING_MIN_CENTS,
  LAPSE_WARNING_WINDOW_DAYS,
} from './billing-page'

describe('lastDayOfDublinMonth', () => {
  it('31-day month', () => {
    expect(lastDayOfDublinMonth('2026-07-20')).toBe('2026-07-31')
  })
  it('30-day month', () => {
    expect(lastDayOfDublinMonth('2026-06-01')).toBe('2026-06-30')
  })
  it('February, non-leap year', () => {
    expect(lastDayOfDublinMonth('2026-02-10')).toBe('2026-02-28')
  })
  it('February, leap year', () => {
    expect(lastDayOfDublinMonth('2028-02-01')).toBe('2028-02-29')
  })
  it('December crosses the year boundary correctly', () => {
    expect(lastDayOfDublinMonth('2026-12-05')).toBe('2026-12-31')
  })
  it('is idempotent on the last day itself', () => {
    expect(lastDayOfDublinMonth('2026-07-31')).toBe('2026-07-31')
  })
})

describe('daysLeftInMonth', () => {
  it('0 on the last day of the month', () => {
    expect(daysLeftInMonth('2026-07-31')).toBe(0)
  })
  it('30 on the first of a 31-day month', () => {
    expect(daysLeftInMonth('2026-07-01')).toBe(30)
  })
  it('7 exactly one week before a 31-day month end', () => {
    expect(daysLeftInMonth('2026-07-24')).toBe(7)
  })
  it('spans the March DST change without drift (calendar math only)', () => {
    // 2026-03-29 is the IST switch; 29th → 31st is still 2 days.
    expect(daysLeftInMonth('2026-03-29')).toBe(2)
  })
})

describe('walletLapseWarning', () => {
  it('warns: > €10 expiring within 7 days', () => {
    expect(walletLapseWarning({ balanceCents: 1001, todayStr: '2026-07-24' })).toBe(true)
    expect(walletLapseWarning({ balanceCents: 25000, todayStr: '2026-07-31' })).toBe(true)
  })
  it('no warning at EXACTLY €10 (strictly greater-than)', () => {
    expect(walletLapseWarning({ balanceCents: LAPSE_WARNING_MIN_CENTS, todayStr: '2026-07-31' })).toBe(false)
  })
  it('no warning when more than 7 days remain', () => {
    // 2026-07-23 → 8 days left of July
    expect(walletLapseWarning({ balanceCents: 5000, todayStr: '2026-07-23' })).toBe(false)
  })
  it('warns at exactly the window boundary (7 days left)', () => {
    expect(LAPSE_WARNING_WINDOW_DAYS).toBe(7)
    expect(walletLapseWarning({ balanceCents: 5000, todayStr: '2026-07-24' })).toBe(true)
  })
  it('never warns on zero or negative (grace-floor) balances', () => {
    expect(walletLapseWarning({ balanceCents: 0, todayStr: '2026-07-31' })).toBe(false)
    expect(walletLapseWarning({ balanceCents: -500, todayStr: '2026-07-31' })).toBe(false)
  })
})

describe('shapeMeterUsage', () => {
  it('keys every METER_KEY with used/allowance/over', () => {
    const shaped = shapeMeterUsage(
      { wa_template_send: 100, email_send: 1000, ai_message: 50 },
      { wa_template_send: 40, email_send: 1200, ai_message: 50 }
    )
    expect(shaped.wa_template_send).toEqual({ used: 40, allowance: 100, over: 0 })
    expect(shaped.email_send).toEqual({ used: 1200, allowance: 1000, over: 200 })
    // at exactly the allowance there is no "+N over"
    expect(shaped.ai_message.over).toBe(0)
  })
  it('treats missing/garbage allowances and usage as 0', () => {
    const shaped = shapeMeterUsage(null, { email_send: 'nonsense' })
    expect(shaped.email_send).toEqual({ used: 0, allowance: 0, over: 0 })
    expect(shaped.wa_template_send).toEqual({ used: 0, allowance: 0, over: 0 })
    expect(shaped.ai_message).toEqual({ used: 0, allowance: 0, over: 0 })
  })
  it('usage with a zero allowance is all overage', () => {
    const shaped = shapeMeterUsage({}, { wa_template_send: 7 })
    expect(shaped.wa_template_send).toEqual({ used: 7, allowance: 0, over: 7 })
  })
})

describe('foldRollupsByLocation', () => {
  it('sums daily rows per location per meter', () => {
    const folded = foldRollupsByLocation([
      { location_id: 'a', meter: 'email_send', quantity: 10 },
      { location_id: 'a', meter: 'email_send', quantity: '5' },
      { location_id: 'a', meter: 'wa_template_send', quantity: 2 },
      { location_id: 'b', meter: 'email_send', quantity: 3 },
    ])
    expect(folded.a.email_send).toBe(15)
    expect(folded.a.wa_template_send).toBe(2)
    expect(folded.b.email_send).toBe(3)
  })
  it('handles empty/null input', () => {
    expect(foldRollupsByLocation(null)).toEqual({})
    expect(foldRollupsByLocation([])).toEqual({})
  })
})
