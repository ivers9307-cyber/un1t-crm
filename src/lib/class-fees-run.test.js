// FEES.1 — the class-fees run: detection, the 17:00 charge and its
// compare-and-set claims, the 7-day retry, outstanding, waive and the staff
// retry. A small in-memory PostgREST fake; the un1t.online charge is stubbed
// (its own tests are un1t-online-write.fee.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./postmark.js', () => ({ sendTransactionalEmail: vi.fn(async () => ({ messageId: 'm1' })) }))
vi.mock('./app-url.js', () => ({ getAppUrl: () => 'https://crm.example.test' }))
vi.mock('./un1t-online-write-ops.js', () => ({ chargeClassFee: vi.fn() }))
vi.mock('./location-time.js', async (orig) => ({ ...(await orig()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

import { chargeClassFee } from './un1t-online-write-ops.js'
import { sendTransactionalEmail } from './postmark.js'
import { makeDb } from './class-fees.test-helpers.js'
import { detectClassFees, chargeDueClassFees, waiveClassFee, retryContactFees, sendReviewEmail, readClassFeeContext } from './class-fees-run.js'

const LOC = 'loc-1'
// FEES.1's flow with every forgiveness rule off (FEES.2's rules have their own tests below).
const NO_FORGIVENESS = { swap: false, spot_refilled: false, new_member: false, first_offence: false, monthly_cap: false }
const SETTINGS = { un1t_online: { writes_enabled: true, fees: { enabled: true, late_cancel_fee_cents: 1000, no_show_fee_cents: 1500, review_emails: ['ops@hatch.test'], forgiveness: NO_FORGIVENESS } } }

const writerFactory = (windowHours = 2) => vi.fn(async () => ({
  locationId: LOC, studioId: 'studio-1',
  read: vi.fn(async () => ({ default_cancelation_window_hours: windowHours })),
}))

const baseTables = (over = {}) => ({
  locations: [{ id: LOC, name: 'Hatch', organization_id: 'org-1', membership_source: 'un1t_online', settings: SETTINGS }],
  un1t_events: [
    { location_id: LOC, un1t_id: 'e1', title: 'Strength', status: 'completed', starts_at: '2026-10-28T18:30:00.000Z' },
    { location_id: LOC, un1t_id: 'e2', title: 'Mobility', status: 'cancelled', starts_at: '2026-10-28T19:30:00.000Z' },
  ],
  un1t_bookings: [
    { location_id: LOC, un1t_id: 'b-noshow', un1t_user_id: 'u1', contact_id: 'c1', event_id: 'e1', status: 'no_show', credit_charged: false },
    { location_id: LOC, un1t_id: 'b-late', un1t_user_id: 'u2', contact_id: 'c2', event_id: 'e1', status: 'cancelled', credit_charged: false, cancelled_at: '2026-10-28T17:45:00.000Z' },
    { location_id: LOC, un1t_id: 'b-early', un1t_user_id: 'u3', contact_id: 'c3', event_id: 'e1', status: 'cancelled', credit_charged: false, cancelled_at: '2026-10-28T09:00:00.000Z' },
    { location_id: LOC, un1t_id: 'b-staff', un1t_user_id: 'u4', contact_id: 'c4', event_id: 'e1', status: 'cancelled', credit_charged: false, cancelled_at: '2026-10-28T18:00:00.000Z' },
    { location_id: LOC, un1t_id: 'b-pack', un1t_user_id: 'u5', contact_id: 'c5', event_id: 'e1', status: 'no_show', credit_charged: true },
    { location_id: LOC, un1t_id: 'b-undecided', un1t_user_id: 'u6', contact_id: 'c6', event_id: 'e1', status: 'booked', credit_charged: false },
    { location_id: LOC, un1t_id: 'b-classoff', un1t_user_id: 'u7', contact_id: 'c7', event_id: 'e2', status: 'no_show', credit_charged: false },
  ],
  un1t_clients: [
    { location_id: LOC, un1t_user_id: 'u1', credit_unlimited: true },
    { location_id: LOC, un1t_user_id: 'u2', credit_unlimited: true },
    { location_id: LOC, un1t_user_id: 'u5', credit_unlimited: false },
  ],
  un1t_write_events: [{ location_id: LOC, op: 'cancel', stage: 'done', origin: 'staff', target: 'b-staff' }],
  contacts: [{ id: 'c1', first_name: 'Ann', last_name: 'A' }, { id: 'c2', first_name: 'Bob', last_name: 'B' }],
  class_fees: [],
  ...over,
})

const NIGHT = Date.parse('2026-10-28T23:05:00Z')
const fees = (db) => db.store.class_fees

beforeEach(() => vi.clearAllMocks())

describe('detectClassFees', () => {
  it('finds the no-show and the late cancel as fees, records the pack forfeit, and skips the rest', async () => {
    const db = makeDb(baseTables())
    const out = await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(out.inserted).toBe(3)
    expect(out.undecided.map((u) => u.bookingId)).toEqual(['b-undecided'])
    const byBooking = Object.fromEntries(fees(db).map((f) => [f.un1t_booking_id, f]))
    expect(Object.keys(byBooking).sort()).toEqual(['b-late', 'b-noshow', 'b-pack'])
    expect(byBooking['b-noshow']).toMatchObject({ status: 'pending', amount_cents: 1500, kind: 'no_show', charge_due_at: '2026-10-29T17:00:00.000Z' })
    expect(byBooking['b-late']).toMatchObject({ status: 'pending', amount_cents: 1000, kind: 'late_cancel', minutes_before_start: 45 })
    expect(byBooking['b-late'].charge_description).toBe('Late cancellation: Strength, Wed 28 Oct 2026, 18:30')
    expect(byBooking['b-pack']).toMatchObject({ status: 'recorded', penalty: 'credit_forfeit', amount_cents: 0 })
  })

  it('a re-run inserts nothing new and never touches a fee already on file', async () => {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    fees(db).find((f) => f.un1t_booking_id === 'b-noshow').status = 'waived'
    const again = await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(again.inserted).toBe(0)
    expect(fees(db).find((f) => f.un1t_booking_id === 'b-noshow').status).toBe('waived')
  })

  it('with no readable un1t.online window, no cancel is called late', async () => {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(null) })
    expect(fees(db).map((f) => f.un1t_booking_id).sort()).toEqual(['b-noshow', 'b-pack'])
  })
})

describe('the review email', () => {
  it('goes to each recipient with the due fees, the counts and the review link', async () => {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    const ctx = await readClassFeeContext(db, LOC)
    const out = await sendReviewEmail(db, { locationId: LOC, location: ctx.location, settings: ctx.settings, zone: ctx.zone, nowMs: NIGHT, undecidedCount: 1 })
    expect(out.sent).toBe(true)
    const mail = sendTransactionalEmail.mock.calls[0][0]
    expect(mail).toMatchObject({ to: 'ops@hatch.test', locationId: LOC, tag: 'class-fees-review' })
    expect(mail.contactId).toBeUndefined()
    expect(mail.subject).toBe('Class fees for Wed 28 Oct: 2 to charge at 17:00 tomorrow')
    expect(mail.htmlBody).toContain('https://crm.example.test/class-fees')
    expect(mail.htmlBody).toContain('Ann A')
    expect(mail.htmlBody).toContain('€25.00')
    expect(mail.htmlBody).toContain('1 booking(s) are still marked booked')
  })
})

describe('chargeDueClassFees', () => {
  const ctxOf = async (db) => readClassFeeContext(db, LOC)
  const DUE = Date.parse('2026-10-29T17:05:00Z')

  async function seeded() {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    return db
  }

  it('nothing is charged before it is due', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    const out = await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-10-29T16:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(out.attempted).toBe(0)
    expect(chargeClassFee).not.toHaveBeenCalled()
  })

  it('charges each due fee once with attempt 1; a credit forfeit is never charged', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockImplementation(async (_db, a) => ({ verdict: 'done', id: `tx-${a.feeId}` }))
    const out = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    expect(out).toMatchObject({ attempted: 2, charged: 2 })
    expect(chargeClassFee.mock.calls.map(([, a]) => [a.attempt, a.origin, a.resume])).toEqual([[1, 'fee_run', false], [1, 'fee_run', false]])
    expect(fees(db).filter((f) => f.status === 'charged')).toHaveLength(2)
    expect(fees(db).find((f) => f.penalty === 'credit_forfeit').status).toBe('recorded')
    // A second run finds nothing to do.
    const again = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    expect(again.attempted).toBe(0)
  })

  it('refused → retry in 7 days with attempt 2 → refused again → outstanding; staff retry then charges it', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockResolvedValue({ verdict: 'refused', code: 'card_declined', message: 'Your card was declined.', retryable: false })
    await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    const f = fees(db).find((x) => x.un1t_booking_id === 'b-noshow')
    expect(f).toMatchObject({ status: 'retry_scheduled', attempts: 1, next_attempt_at: '2026-11-05T17:00:00.000Z', failure_message: 'Your card was declined.' })

    await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-11-05T17:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(chargeClassFee.mock.calls.at(-1)[1].attempt).toBe(2)
    expect(fees(db).find((x) => x.un1t_booking_id === 'b-noshow')).toMatchObject({ status: 'outstanding', attempts: 2 })

    chargeClassFee.mockResolvedValue({ verdict: 'done', id: 'tx-late' })
    const r = await retryContactFees(db, { locationId: LOC, contactId: 'c1', actor: { id: 'staff-1' } })
    expect(r.outcomes).toEqual([expect.objectContaining({ status: 'charged' })])
    expect(chargeClassFee.mock.calls.at(-1)[1]).toMatchObject({ attempt: 3, origin: 'staff', actor: { id: 'staff-1' } })
  })

  it('a refusal that sent nothing hands the attempt back and stays pending', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockResolvedValue({ verdict: 'refused', code: 'UN1T_RATE_BUDGET', retryable: true })
    await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    for (const f of fees(db).filter((x) => x.penalty === 'fee')) expect(f).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('unknown stays charging; after 15 minutes the run resumes the same attempt', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockResolvedValue({ verdict: 'unknown' })
    await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    expect(fees(db).filter((x) => x.status === 'charging')).toHaveLength(2)
    // Ten minutes later: still in flight, left alone.
    const early = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE + 10 * 60_000, settings: ctx.settings, zone: ctx.zone })
    expect(early.attempted).toBe(0)
    chargeClassFee.mockResolvedValue({ verdict: 'done', id: 'tx-r' })
    const later = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE + 60 * 60_000, settings: ctx.settings, zone: ctx.zone })
    expect(later.charged).toBe(2)
    expect(chargeClassFee.mock.calls.at(-1)[1]).toMatchObject({ attempt: 1, resume: true })
  })
})

describe('waiveClassFee', () => {
  it('waives a pending fee; a charged one or another studio is refused', async () => {
    const db = makeDb(baseTables({ class_fees: [
      { id: 'f1', location_id: LOC, status: 'pending' },
      { id: 'f2', location_id: LOC, status: 'charged' },
      { id: 'f3', location_id: 'other', status: 'pending' },
    ] }))
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f1', actorId: 'u', reason: 'injured' })).toEqual({ ok: true, status: 'waived' })
    expect(fees(db)[0]).toMatchObject({ status: 'waived', waived_by: 'u', waived_reason: 'injured' })
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f2', actorId: 'u', reason: 'x' })).toMatchObject({ ok: false, reason: 'not_waivable' })
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f3', actorId: 'u', reason: 'x' })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('a waive that loses the race to the 17:00 claim changes nothing', async () => {
    const db = makeDb(baseTables({ class_fees: [{ id: 'f1', location_id: LOC, status: 'pending' }] }))
    const realFrom = db.from.bind(db)
    // The claim lands between the waive's read and its write.
    db.from = (name) => {
      const q = realFrom(name)
      const update = q.update
      q.update = (p) => { db.store.class_fees[0].status = 'charging'; return update(p) }
      return q
    }
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f1', actorId: 'u', reason: 'x' })).toMatchObject({ ok: false, reason: 'not_waivable' })
    expect(db.store.class_fees[0].status).toBe('charging')
  })
})

describe('FEES.2 — forgiveness in the nightly run', () => {
  const withRules = (forgiveness) => baseTables({
    locations: [{ id: LOC, name: 'Hatch', organization_id: 'org-1', membership_source: 'un1t_online', settings: {
      un1t_online: { writes_enabled: true, fees: { enabled: true, late_cancel_fee_cents: 1000, no_show_fee_cents: 1500, review_emails: ['ops@hatch.test'], forgiveness } },
    } }],
  })

  it('by default a first offence is written as waived with its rule, and never charged', async () => {
    const db = makeDb(withRules(undefined))
    const out = await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(out.forgiven).toBe(2)
    const f = fees(db).find((x) => x.un1t_booking_id === 'b-noshow')
    expect(f).toMatchObject({ status: 'waived', waive_rule: 'first_offence', waived_by: null, waived_reason: 'First offence, a warning only (automatic)' })
    expect(f.waived_at).toBeTruthy()
    const ctx = await readClassFeeContext(db, LOC)
    const charged = await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-10-29T17:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(charged.attempted).toBe(0)
  })

  it('a second offence inside 60 days is charged', async () => {
    const db = makeDb(withRules({ swap: false, new_member: false, first_offence: true }))
    db.store.class_fees.push({ id: 'old', location_id: LOC, un1t_user_id: 'u1', un1t_booking_id: 'old-b', starts_at: '2026-10-10T18:30:00.000Z', class_day: '2026-10-10', status: 'charged', penalty: 'fee', waive_rule: null })
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    const f = fees(db).find((x) => x.un1t_booking_id === 'b-noshow')
    expect(f.status).toBe('pending')
    expect(f.waive_rule).toBeUndefined()
  })

  it('a late cancel followed by a booking into another class is a swap', async () => {
    const t = withRules({ swap: true, new_member: false, first_offence: false })
    t.un1t_bookings.push({ location_id: LOC, un1t_id: 'b-new', un1t_user_id: 'u2', contact_id: 'c2', event_id: 'e9', status: 'booked', credit_charged: false, remote_created_at: '2026-10-28T17:45:40.000Z' })
    const db = makeDb(t)
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(fees(db).find((x) => x.un1t_booking_id === 'b-late')).toMatchObject({ status: 'waived', waive_rule: 'swap' })
    expect(fees(db).find((x) => x.un1t_booking_id === 'b-noshow').status).toBe('pending')
  })

  it('the review email counts what was forgiven', async () => {
    const db = makeDb(withRules(undefined))
    const out = await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    const ctx = await readClassFeeContext(db, LOC)
    await sendReviewEmail(db, { locationId: LOC, location: ctx.location, settings: ctx.settings, zone: ctx.zone, nowMs: NIGHT, undecidedCount: 0, forgivenCount: out.forgiven })
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toContain('2 fee(s) forgiven automatically')
  })
})

describe('FEES.3 — the dry run never charges', () => {
  const paused = (pausedFlag) => baseTables({
    locations: [{ id: LOC, name: 'Hatch', organization_id: 'org-1', membership_source: 'un1t_online', settings: {
      un1t_online: { writes_enabled: true, fees: { enabled: true, charging_paused: pausedFlag, late_cancel_fee_cents: 1000, no_show_fee_cents: 1500, review_emails: ['ops@hatch.test'], forgiveness: NO_FORGIVENESS } },
    } }],
  })

  it('a paused night writes previews; un-pausing later still charges none of them', async () => {
    const db = makeDb(paused(true))
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(fees(db).filter((f) => f.penalty === 'fee').map((f) => f.status)).toEqual(['preview', 'preview'])
    db.store.locations[0].settings.un1t_online.fees.charging_paused = false
    const ctx = await readClassFeeContext(db, LOC)
    chargeClassFee.mockResolvedValue({ verdict: 'done', id: 'tx' })
    const out = await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-11-05T17:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(out.attempted).toBe(0)
    expect(chargeClassFee).not.toHaveBeenCalled()
  })

  it('a paused night also turns a leftover pending fee (written by older code) into a preview', async () => {
    const db = makeDb(paused(true))
    db.store.class_fees.push({ id: 'old', location_id: LOC, status: 'pending', penalty: 'fee', un1t_booking_id: 'old-b', un1t_user_id: 'u9', starts_at: '2026-10-27T18:30:00.000Z', class_day: '2026-10-27' })
    db.store.class_fees.push({ id: 'other-studio', location_id: 'loc-2', status: 'pending', penalty: 'fee', un1t_booking_id: 'x', un1t_user_id: 'u9', starts_at: '2026-10-27T18:30:00.000Z', class_day: '2026-10-27' })
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(fees(db).find((f) => f.id === 'old').status).toBe('preview')
    expect(fees(db).find((f) => f.id === 'other-studio').status).toBe('pending')
  })

  it('the paused email says dry run and lists the previews', async () => {
    const db = makeDb(paused(true))
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    const ctx = await readClassFeeContext(db, LOC)
    await sendReviewEmail(db, { locationId: LOC, location: ctx.location, settings: ctx.settings, zone: ctx.zone, nowMs: NIGHT, undecidedCount: 0 })
    const mail = sendTransactionalEmail.mock.calls[0][0]
    expect(mail.subject).toBe('Class fees for Wed 28 Oct (dry run): 2 would be charged')
    expect(mail.htmlBody).toContain('no member is emailed while charging is paused')
  })

  it('an appealed fee is never picked up by the charge run', async () => {
    const db = makeDb(paused(false))
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    for (const f of fees(db).filter((x) => x.penalty === 'fee')) Object.assign(f, { status: 'appealed', appealed_at: 'x', appeal_reason: 'illness' })
    const ctx = await readClassFeeContext(db, LOC)
    const out = await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-10-29T17:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(out.attempted).toBe(0)
  })
})

describe('FEES.4 — never-charged members', () => {
  it('an exempt member\'s offence is written as waived with rule exempt; others are unaffected', async () => {
    const db = makeDb(baseTables({ class_fee_exemptions: [{ id: 'x1', location_id: LOC, contact_id: 'c1' }] }))
    const out = await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(out.forgiven).toBe(1)
    expect(fees(db).find((f) => f.un1t_booking_id === 'b-noshow')).toMatchObject({ status: 'waived', waive_rule: 'exempt' })
    expect(fees(db).find((f) => f.un1t_booking_id === 'b-late').status).toBe('pending')
  })

  it('a member exempted after the fee was found is never charged by the 17:00 run', async () => {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    db.store.class_fee_exemptions = [{ id: 'x1', location_id: LOC, contact_id: 'c1' }]
    const ctx = await readClassFeeContext(db, LOC)
    chargeClassFee.mockResolvedValue({ verdict: 'done', id: 'tx' })
    const out = await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-10-29T17:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(out.attempted).toBe(1)
    expect(chargeClassFee.mock.calls.map(([, a]) => a.contactId)).toEqual(['c2'])
    expect(fees(db).find((f) => f.un1t_booking_id === 'b-noshow')).toMatchObject({ status: 'waived', waive_rule: 'exempt' })
  })
})
