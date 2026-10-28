import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./location-time.js', async (orig) => ({ ...(await orig()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

import { makeDb } from './class-fees.test-helpers.js'
import { lateCancelQuote, lateCancelWarning } from './class-fees-quote.js'

const LOC = 'loc-1'
const NOW = Date.parse('2026-10-28T17:00:00Z')
const START = '2026-10-28T18:30:00.000Z' // 90 minutes away

const tables = ({ fees = {}, unlimited = true, prior = [] } = {}) => ({
  locations: [{ id: LOC, settings: { un1t_online: { fees: { enabled: true, late_cancel_fee_cents: 1000, no_show_fee_cents: 1500, ...fees } } } }],
  un1t_clients: [{ location_id: LOC, un1t_user_id: 'u1', credit_unlimited: unlimited, remote_created_at: '2025-01-01T00:00:00.000Z' }],
  un1t_transactions: [],
  un1t_bookings: [],
  class_fees: prior,
})
const args = (over = {}) => ({
  locationId: LOC, un1tUserId: 'u1', bookingId: 'b1', eventId: 'e1', startsAt: START, creditCharged: false,
  readWindowHours: vi.fn(async () => 2), nowMs: NOW, ...over,
})
const anOffence = { location_id: LOC, un1t_user_id: 'u1', un1t_booking_id: 'old', starts_at: '2026-10-10T18:30:00.000Z', class_day: '2026-10-10', status: 'charged', penalty: 'fee', waive_rule: null }

describe('lateCancelQuote', () => {
  it('fees off: no fee, and un1t.online is never asked for the window', async () => {
    const a = args()
    expect(await lateCancelQuote(makeDb(tables({ fees: { enabled: false } })), a)).toEqual({ applies: false, reason: 'fees_off' })
    expect(a.readWindowHours).not.toHaveBeenCalled()
  })

  it('outside the window, or no readable window: no fee', async () => {
    expect(await lateCancelQuote(makeDb(tables()), args({ readWindowHours: async () => 1 }))).toEqual({ applies: false, reason: 'in_time' })
    expect(await lateCancelQuote(makeDb(tables()), args({ readWindowHours: async () => null }))).toEqual({ applies: false, reason: 'no_window' })
  })

  it('a first offence is forgiven by default, so no warning', async () => {
    expect(await lateCancelQuote(makeDb(tables()), args())).toEqual({ applies: false, reason: 'forgiven:first_offence' })
  })

  it('a repeat offender is quoted the fee, with the swap window', async () => {
    const q = await lateCancelQuote(makeDb(tables({ prior: [anOffence] })), args())
    expect(q).toEqual({ applies: true, penalty: 'fee', amountCents: 1000, windowHours: 2, swapMinutes: 30 })
  })

  it('a pack booking that spent a credit loses the credit', async () => {
    const q = await lateCancelQuote(makeDb(tables({ unlimited: false })), args({ creditCharged: true }))
    expect(q).toMatchObject({ applies: true, penalty: 'credit_forfeit', windowHours: 2 })
  })

  it('no amount set means no fee to warn about', async () => {
    const q = await lateCancelQuote(makeDb(tables({ fees: { late_cancel_fee_cents: 0 }, prior: [anOffence] })), args())
    expect(q).toEqual({ applies: false, reason: 'no_amount' })
  })
})

describe('lateCancelWarning', () => {
  it('says nothing was cancelled, the cost, the swap and the confirm flag', () => {
    const w = lateCancelWarning({ applies: true, penalty: 'fee', amountCents: 1250, windowHours: 2, swapMinutes: 30 })
    expect(w).toMatch(/^NOT CANCELLED YET/)
    expect(w).toMatch(/€12.50 late-cancellation fee/)
    expect(w).toMatch(/within 30 minutes of cancelling, no fee is charged/)
    expect(w).toMatch(/confirm_late_fee true/)
    expect(w).not.toMatch(/[—–]/)
    expect(lateCancelWarning({ applies: true, penalty: 'fee', amountCents: 1000, windowHours: 2, swapMinutes: null })).toMatch(/€10 late/)
  })
})
