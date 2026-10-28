import { describe, it, expect } from 'vitest'
import {
  classFeeSettingsFrom,
  classifyBooking,
  penaltyFor,
  feeDescription,
  nextLocalHourAfter,
  retryAtAfter,
  buildFeeRow,
  patchAfterCharge,
  localHourIn,
} from './class-fees.js'

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const at = (iso) => Date.parse(iso)

describe('classFeeSettingsFrom', () => {
  it('is off and empty for anything unreadable', () => {
    for (const s of [null, undefined, 'x', {}, { un1t_online: 'x' }, { un1t_online: { fees: [] } }]) {
      const out = classFeeSettingsFrom(s)
      expect(out.enabled).toBe(false)
      expect(out.lateCancelFeeCents).toBe(0)
      expect(out.reviewEmails).toEqual([])
      expect(out.detectHour).toBe(23)
      expect(out.chargeHour).toBe(17)
      expect(out.retryDays).toBe(7)
    }
  })

  it('only the literal true switches fees on; amounts and emails are cleaned', () => {
    const out = classFeeSettingsFrom({ un1t_online: { fees: {
      enabled: 'true', charging_paused: true, late_cancel_fee_cents: 1000, no_show_fee_cents: 1.5,
      review_emails: [' Ops@Hatch.ie ', 'ops@hatch.ie', 'not-an-email', 7],
    } } })
    expect(out.enabled).toBe(false)
    expect(out.chargingPaused).toBe(true)
    expect(out.lateCancelFeeCents).toBe(1000)
    expect(out.noShowFeeCents).toBe(0)
    expect(out.reviewEmails).toEqual(['ops@hatch.ie'])
    expect(classFeeSettingsFrom({ un1t_online: { fees: { enabled: true } } }).enabled).toBe(true)
  })

  it('refuses an amount above the ceiling', () => {
    expect(classFeeSettingsFrom({ un1t_online: { fees: { late_cancel_fee_cents: 100_001 } } }).lateCancelFeeCents).toBe(0)
  })
})

describe('classifyBooking', () => {
  const event = { starts_at: '2026-10-28T18:30:00Z', status: 'completed' }
  const now = at('2026-10-28T23:00:00Z')
  const ctx = { windowHours: 2, nowMs: now }

  it('a no-show is an offence', () => {
    expect(classifyBooking({ status: 'no_show' }, event, ctx)).toEqual({ kind: 'no_show', minutesBeforeStart: null, cancelledAt: null })
  })

  it('a booking still booked after the class is undecided, never an offence', () => {
    expect(classifyBooking({ status: 'booked' }, event, ctx)).toEqual({ undecided: true })
  })

  it('attended is nothing', () => {
    expect(classifyBooking({ status: 'attended' }, event, ctx)).toBeNull()
  })

  it('a cancel inside the window is late; at or past the window it is not', () => {
    const late = classifyBooking({ status: 'cancelled', cancelled_at: '2026-10-28T16:31:00Z' }, event, ctx)
    expect(late).toEqual({ kind: 'late_cancel', minutesBeforeStart: 119, cancelledAt: '2026-10-28T16:31:00.000Z' })
    expect(classifyBooking({ status: 'cancelled', cancelled_at: '2026-10-28T16:30:00Z' }, event, ctx)).toBeNull()
    expect(classifyBooking({ status: 'cancelled', cancelled_at: '2026-10-27T09:00:00Z' }, event, ctx)).toBeNull()
  })

  it('a cancel after the class started is late', () => {
    expect(classifyBooking({ status: 'cancelled', cancelled_at: '2026-10-28T18:40:00Z' }, event, ctx).kind).toBe('late_cancel')
  })

  it('a staff cancel, a cancelled class, a class not yet started and an unknown window are never fined', () => {
    const b = { status: 'cancelled', cancelled_at: '2026-10-28T18:00:00Z' }
    expect(classifyBooking(b, event, { ...ctx, staffCancelled: true })).toBeNull()
    expect(classifyBooking(b, { ...event, status: 'cancelled' }, ctx)).toBeNull()
    expect(classifyBooking({ status: 'no_show' }, event, { ...ctx, nowMs: at('2026-10-28T18:00:00Z') })).toBeNull()
    expect(classifyBooking(b, event, { ...ctx, windowHours: null })).toBeNull()
    expect(classifyBooking({ status: 'cancelled', cancelled_at: null }, event, ctx)).toBeNull()
  })

  it('the window is measured in real time across a DST change', () => {
    // Dublin falls back 25 Oct 2026 02:00 → 01:00. A 03:00 class; a cancel at
    // 00:30 local is 3.5 real hours before, not 2.5.
    const dst = { starts_at: '2026-10-25T03:00:00Z', status: 'completed' }
    const b = { status: 'cancelled', cancelled_at: '2026-10-24T23:30:00Z' }
    expect(classifyBooking(b, dst, { windowHours: 3, nowMs: at('2026-10-25T23:00:00Z') })).toBeNull()
    expect(classifyBooking(b, dst, { windowHours: 4, nowMs: at('2026-10-25T23:00:00Z') }).minutesBeforeStart).toBe(210)
  })
})

describe('penaltyFor', () => {
  it('unlimited pays; a credit spent is forfeit; anything else pays', () => {
    expect(penaltyFor({ credit_charged: true }, { credit_unlimited: true })).toBe('fee')
    expect(penaltyFor({ credit_charged: true }, { credit_unlimited: false })).toBe('credit_forfeit')
    expect(penaltyFor({ credit_charged: false }, { credit_unlimited: false })).toBe('fee')
    expect(penaltyFor({ credit_charged: true }, null)).toBe('credit_forfeit')
  })
})

describe('feeDescription', () => {
  it('names the kind, class, day and local time', () => {
    expect(feeDescription({ kind: 'late_cancel', classTitle: 'HYROX Engine', startsAt: '2026-10-28T18:30:00Z', zone: DUB }))
      .toBe('Late cancellation: HYROX Engine, Wed 28 Oct 2026, 18:30')
    expect(feeDescription({ kind: 'no_show', classTitle: '', startsAt: '2026-07-01T06:00:00Z', zone: DUB }))
      .toBe('No-show: Class, Wed 1 Jul 2026, 07:00')
    expect(feeDescription({ kind: 'no_show', classTitle: 'Strength', startsAt: '2026-07-01T06:00:00Z', zone: NY }))
      .toBe('No-show: Strength, Wed 1 Jul 2026, 02:00')
  })

  it('never exceeds 200 characters', () => {
    expect(feeDescription({ kind: 'no_show', classTitle: 'x'.repeat(400), startsAt: '2026-07-01T06:00:00Z', zone: DUB }).length).toBe(200)
  })
})

describe('scheduling', () => {
  it('a fee found at 23:00 is due 17:00 the next day, local, across DST', () => {
    // Dublin, Sat 24 Oct 23:05 IST (22:05Z) → Sun 25 Oct 17:00 GMT (17:00Z).
    expect(nextLocalHourAfter(at('2026-10-24T22:05:00Z'), 17, DUB)).toBe('2026-10-25T17:00:00.000Z')
    // New York, Sat 31 Oct 23:05 EDT → Sun 1 Nov 17:00 EST (22:00Z).
    expect(nextLocalHourAfter(at('2026-11-01T03:05:00Z'), 17, NY)).toBe('2026-11-01T22:00:00.000Z')
  })

  it('the retry is 7 local days later at the charge hour', () => {
    expect(retryAtAfter(at('2026-10-20T16:05:00Z'), 7, 17, DUB)).toBe('2026-10-27T17:00:00.000Z')
    expect(retryAtAfter(at('2026-10-29T21:05:00Z'), 7, 17, NY)).toBe('2026-11-05T22:00:00.000Z')
  })

  it('localHourIn reads the studio clock', () => {
    expect(localHourIn(at('2026-07-01T22:05:00Z'), DUB)).toBe(23)
    expect(localHourIn(at('2026-12-01T23:05:00Z'), DUB)).toBe(23)
  })
})

describe('buildFeeRow', () => {
  const base = {
    locationId: 'loc', contactId: 'c1', zone: DUB, nowMs: at('2026-10-28T23:05:00Z'),
    booking: { un1t_id: 'b1', un1t_user_id: 'u1' },
    event: { un1t_id: 'e1', title: 'Strength', starts_at: '2026-10-28T18:30:00Z' },
    settings: classFeeSettingsFrom({ un1t_online: { fees: { late_cancel_fee_cents: 1000, no_show_fee_cents: 1500 } } }),
  }

  it('a fee is pending with its amount, description and due time', () => {
    const row = buildFeeRow({ ...base, classified: { kind: 'no_show', minutesBeforeStart: null, cancelledAt: null }, penalty: 'fee' })
    expect(row).toMatchObject({
      status: 'pending', amount_cents: 1500, penalty: 'fee', kind: 'no_show', class_day: '2026-10-28',
      charge_description: 'No-show: Strength, Wed 28 Oct 2026, 18:30', charge_due_at: '2026-10-29T17:00:00.000Z',
      un1t_booking_id: 'b1', un1t_user_id: 'u1', contact_id: 'c1',
    })
  })

  it('a credit forfeit is recorded with no money', () => {
    const row = buildFeeRow({ ...base, classified: { kind: 'no_show', minutesBeforeStart: null, cancelledAt: null }, penalty: 'credit_forfeit' })
    expect(row).toMatchObject({ status: 'recorded', amount_cents: 0, charge_description: null })
  })

  it('no amount set means no fee row', () => {
    const settings = classFeeSettingsFrom({})
    expect(buildFeeRow({ ...base, settings, classified: { kind: 'no_show' }, penalty: 'fee' })).toBeNull()
  })
})

describe('patchAfterCharge', () => {
  const settings = classFeeSettingsFrom({})
  const ctx = { nowMs: at('2026-10-29T17:05:00Z'), settings, zone: DUB }

  it('done is charged with the transaction id', () => {
    expect(patchAfterCharge({ verdict: 'done', id: 'tx1' }, { ...ctx, prevStatus: 'pending', origin: 'fee_run' }))
      .toMatchObject({ status: 'charged', un1t_transaction_id: 'tx1', failure_code: null })
  })

  it('the first automatic refusal is retried 7 days later; the second is outstanding', () => {
    const refused = { verdict: 'refused', code: 'NO_CARD_ON_FILE', message: 'no card', retryable: false }
    expect(patchAfterCharge(refused, { ...ctx, prevStatus: 'pending', origin: 'fee_run' }))
      .toMatchObject({ status: 'retry_scheduled', next_attempt_at: '2026-11-05T17:00:00.000Z', failure_code: 'NO_CARD_ON_FILE' })
    expect(patchAfterCharge(refused, { ...ctx, prevStatus: 'retry_scheduled', origin: 'fee_run' }))
      .toMatchObject({ status: 'outstanding', next_attempt_at: null })
  })

  it('a refused staff retry keeps a scheduled retry, and an outstanding fee stays outstanding', () => {
    const refused = { verdict: 'refused', code: 'card_declined', retryable: false }
    const kept = patchAfterCharge(refused, { ...ctx, prevStatus: 'retry_scheduled', origin: 'staff' })
    expect(kept.status).toBe('retry_scheduled')
    expect(kept).not.toHaveProperty('next_attempt_at')
    expect(patchAfterCharge(refused, { ...ctx, prevStatus: 'outstanding', origin: 'staff' }).status).toBe('outstanding')
  })

  it('a refusal that sent nothing returns the fee and hands the attempt back', () => {
    expect(patchAfterCharge({ verdict: 'refused', code: 'UN1T_RATE_BUDGET', retryable: true }, { ...ctx, prevStatus: 'pending', origin: 'fee_run' }))
      .toMatchObject({ status: 'pending', releaseAttempt: true })
  })

  it('unknown stays charging for the same key', () => {
    expect(patchAfterCharge({ verdict: 'unknown' }, { ...ctx, prevStatus: 'pending', origin: 'fee_run' }).status).toBe('charging')
  })
})
