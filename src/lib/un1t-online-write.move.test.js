// UN1TMOVE.1 — moveBooking: one POST /bookings/{id}/move { eventId } instead
// of a cancel then a book (which leaves a window where the credit or the spot
// is lost). Fakes only: never the live API, never a database.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))

import { createUn1tWriter, UN1T_WRITE_CODES, _resetUn1tWriteStateForTests } from './un1t-online-write.js'
import { moveBooking, cancel, findMoveState, UN1T_MOVE_CODES } from './un1t-online-write-ops.js'
import { UN1T_LATE_MOVE_CODES as L } from './un1t-online-late-move.js'
import { judgeUn1tWrite, REQUIRED_PERMISSIONS, missingPermissions } from './un1t-online-write-judge.js'
import { ledgerKey } from './un1t-online-write-ledger.js'
import { Un1tSettingsReadError } from './un1t-online-settings.js'
import {
  LOC, ORG, STUDIO, EVENT, USER, BOOKING, CONTACT,
  res, ok, makeFetch, makeDb, selfRes,
} from './un1t-online-write.test-helpers.js'

const C = UN1T_WRITE_CODES
const TARGET = '88888888-8888-4888-8888-888888888888'
const MOVE_PATH = `POST /bookings/${BOOKING}/move`
const BOOKING_PATH = `GET /bookings/${BOOKING}`
const CREDITS_PATH = `GET /credits/ledgers/${USER}/${STUDIO}`
const soon = (ms = 5_000) => new Date(Date.now() + ms).toISOString()
const ago = (ms) => new Date(Date.now() - ms).toISOString()

async function setup({ routes = {}, db: dbOpts = {}, perms } = {}) {
  const made = makeDb(dbOpts)
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes(perms)], ...routes })
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep: vi.fn(async () => {}) }))
  return { ...made, fetchImpl, deps: { writerFactory, now: () => new Date() } }
}

const dto = (over = {}) => ({
  id: BOOKING, event_id: TARGET, user_id: USER, studio_id: STUDIO, status: 'booked',
  created_at: ago(86_400_000), updated_at: soon(), ...over,
})
const args = (over = {}) => ({
  locationId: LOC, contactId: CONTACT, un1tUserId: USER, bookingId: BOOKING, eventId: TARGET, fromEventId: EVENT,
  origin: 'staff', actor: { id: 'staff-1' }, ...over,
})
const credits = () => ok({ balance: 3, is_unlimited: false })
const ledger = (store) => store.un1t_write_events

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('the codes other modules name as literals', () => {
  it('un1t-staff-booking.js and agent/un1t-booking.js spell these exactly', () => {
    expect(UN1T_MOVE_CODES).toEqual({ SAME_CLASS: 'move_same_class', PRIOR_MOVE_UNVERIFIED: 'move_unverified' })
  })
})

describe('the judge and the permission table', () => {
  it('move needs bookings:update and bookings:read', () => {
    expect(REQUIRED_PERMISSIONS.move).toEqual(['bookings:update', 'bookings:read'])
    expect(missingPermissions('move', ['bookings:read'])).toEqual(['bookings:update'])
  })

  const expect_ = { eventId: TARGET, userId: USER, studioId: STUDIO, bookingId: BOOKING }
  it('a 200 naming the booking at the target event, booked, is done with its id', () => {
    expect(judgeUn1tWrite('move', { status: 200, body: { success: true, data: dto() }, expect: expect_ })).toMatchObject({ verdict: 'done', id: BOOKING })
  })
  it('a 200 at another event, another user, or not booked is unknown response_mismatch (never done)', () => {
    for (const over of [{ event_id: EVENT }, { user_id: 'someone-else' }, { status: 'cancelled' }, { studio_id: 'other' }]) {
      expect(judgeUn1tWrite('move', { status: 200, body: { success: true, data: dto(over) }, expect: expect_ }), JSON.stringify(over))
        .toMatchObject({ verdict: 'unknown', code: 'response_mismatch' })
    }
  })
  it('a 200 with no id is unknown', () => {
    expect(judgeUn1tWrite('move', { status: 200, body: { success: true, data: {} }, expect: expect_ }).verdict).toBe('unknown')
  })
  it('a 200 with success:false is a refusal with un1t.online\'s code and words; a 4xx too', () => {
    expect(judgeUn1tWrite('move', { status: 200, body: { success: false, error: { code: 'EVENT_FULL', message: 'Class is full' } }, expect: expect_ }))
      .toMatchObject({ verdict: 'refused', code: 'EVENT_FULL', message: 'Class is full', alreadyBooked: false })
    expect(judgeUn1tWrite('move', { status: 400, body: { message: 'Event is in the past' }, expect: expect_ }))
      .toMatchObject({ verdict: 'refused', code: 'http_400', message: 'Event is in the past' })
  })
  it('an "already booked" refusal is a refusal for a move, never a done (the original booking still stands)', () => {
    expect(judgeUn1tWrite('move', { status: 409, body: { message: 'User already booked for this event' }, expect: expect_ }))
      .toMatchObject({ verdict: 'refused', alreadyBooked: false })
  })
})

describe('the allowlist', () => {
  it('POST /bookings/{id}/move takes exactly { eventId }, under op move only', async () => {
    const t = await setup()
    const writer = await t.deps.writerFactory(t.db, LOC)
    expect(() => writer.assertAllowed('move', 'POST', `/bookings/${BOOKING}/move`, { eventId: TARGET })).not.toThrow()
    expect(() => writer.assertAllowed('move', 'POST', `/bookings/${BOOKING}/move`, { eventId: TARGET, userId: USER })).toThrow(TypeError)
    expect(() => writer.assertAllowed('move', 'POST', `/bookings/${BOOKING}/move`, { eventId: TARGET, bypassCredit: true })).toThrow(TypeError)
    expect(() => writer.assertAllowed('book', 'POST', `/bookings/${BOOKING}/move`, { eventId: TARGET })).toThrow(TypeError)
    expect(() => writer.assertAllowed('move', 'PATCH', `/bookings/${BOOKING}/move`, { eventId: TARGET })).toThrow(TypeError)
    expect(() => writer.assertAllowed('move', 'POST', '/bookings', { eventId: TARGET })).toThrow(TypeError)
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })
})

describe('moveBooking', () => {
  it('sends exactly { eventId } once, records done under move:<loc>:<booking>:<event>, and moves the mirror and class_bookings row at once', async () => {
    const t = await setup({
      routes: { [MOVE_PATH]: [ok(dto())], [CREDITS_PATH]: [credits()] },
      db: { tables: {
        un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, un1t_user_id: USER, event_id: EVENT, status: 'booked' }],
        un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER, credit_balance: 3 }],
        un1t_events: [
          { id: 'ue-1', location_id: LOC, un1t_id: EVENT, title: 'HYROX', starts_at: '2026-11-02T07:00:00.000Z' },
          { id: 'ue-2', location_id: LOC, un1t_id: TARGET, title: 'Strength', starts_at: '2026-11-03T09:00:00.000Z' },
        ],
        contacts: [{ id: CONTACT, organization_id: ORG, name: 'Test Person', un1t_user_id: USER }],
        class_bookings: [{ id: 'cb-1', location_id: LOC, glofox_booking_id: `un1t:${BOOKING}`, glofox_event_id: `un1t:${EVENT}`, source_platform: 'un1t_online', status: 'BOOKED', raw: { un1t: { written_by: 'sync' } } }],
      } },
    })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, sent: true })
    const writes = t.fetchImpl.writes()
    expect(writes).toHaveLength(1)
    expect(writes[0].key).toBe(MOVE_PATH)
    expect(writes[0].body).toEqual({ eventId: TARGET })
    expect(ledger(t.store)[0]).toMatchObject({
      op: 'move', stage: 'done', un1t_ref: BOOKING, target: BOOKING, late_window: false, origin: 'staff', actor_user_id: 'staff-1',
      idempotency_key: ledgerKey.move(LOC, BOOKING, TARGET),
    })
    expect(ledger(t.store)[0].idempotency_key).toBe(`move:${LOC}:${BOOKING}:${TARGET}`)
    expect(t.store.un1t_bookings).toHaveLength(1)
    expect(t.store.un1t_bookings[0]).toMatchObject({ un1t_id: BOOKING, event_id: TARGET, status: 'booked', contact_id: CONTACT })
    expect(t.store.un1t_bookings[0].crm_written_at).toEqual(expect.any(String))
    expect(t.store.class_bookings).toHaveLength(1)
    expect(t.store.class_bookings[0]).toMatchObject({
      id: 'cb-1', glofox_booking_id: `un1t:${BOOKING}`, glofox_event_id: `un1t:${TARGET}`, class_name: 'Strength',
      starts_at: '2026-11-03T09:00:00.000Z', status: 'BOOKED', raw: { un1t: { written_by: 'crm' } },
    })
    expect(r.data).toMatchObject({ un1t_id: BOOKING, event_id: TARGET })
  })

  it('a refusal body (200 success:false) is refused with un1t.online\'s words; nothing re-sent, the mirror untouched', async () => {
    const t = await setup({
      routes: { [MOVE_PATH]: [res(200, { success: false, error: { code: 'EVENT_FULL', message: 'This class is full' } })] },
      db: { tables: { un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, un1t_user_id: USER, event_id: EVENT, status: 'booked' }] } },
    })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: 'EVENT_FULL', message: 'This class is full', sent: true })
    expect(t.fetchImpl.count(MOVE_PATH)).toBe(1)
    expect(ledger(t.store)[0]).toMatchObject({ op: 'move', stage: 'refused', code: 'EVENT_FULL' })
    expect(t.store.un1t_bookings[0].event_id).toBe(EVENT)
  })

  describe('a 5xx: the check read GET /bookings/{id} decides', () => {
    it('at the target event and booked → landed: done, never re-sent', async () => {
      const t = await setup({ routes: { [MOVE_PATH]: [res(502, {})], [BOOKING_PATH]: [ok(dto())], [CREDITS_PATH]: [credits()] } })
      const r = await moveBooking(t.db, args(), t.deps)
      expect(r).toMatchObject({ verdict: 'done', id: BOOKING, recovered: 'landed_after_5xx' })
      expect(t.fetchImpl.count(MOVE_PATH)).toBe(1)
    })
    it('still at the original event and booked → absent: re-sent once', async () => {
      const t = await setup({ routes: { [MOVE_PATH]: [res(502, {}), ok(dto())], [BOOKING_PATH]: [ok(dto({ event_id: EVENT }))], [CREDITS_PATH]: [credits()] } })
      const r = await moveBooking(t.db, args(), t.deps)
      expect(r.verdict).toBe('done')
      expect(t.fetchImpl.count(MOVE_PATH)).toBe(2)
    })
    for (const [name, row] of [
      ['cancelled', dto({ status: 'cancelled' })],
      ['a third event', dto({ event_id: '99999999-9999-4999-8999-999999999999' })],
      ['another client\'s booking', dto({ event_id: EVENT, user_id: 'someone-else' })],
      ['another booking id', dto({ id: 'other-booking', event_id: EVENT })],
    ]) {
      it(`${name} → unknown, never re-sent`, async () => {
        const t = await setup({ routes: { [MOVE_PATH]: [res(502, {}), ok(dto())], [BOOKING_PATH]: [ok(row)] } })
        const r = await moveBooking(t.db, args(), t.deps)
        expect(r.verdict).toBe('unknown')
        expect(t.fetchImpl.count(MOVE_PATH)).toBe(1)
        expect(ledger(t.store)[0]).toMatchObject({ stage: 'unknown' })
      })
    }
    it('a failed check read → unknown, never re-sent', async () => {
      const t = await setup({ routes: { [MOVE_PATH]: [res(502, {}), ok(dto())], [BOOKING_PATH]: [res(500, {})] } })
      const r = await moveBooking(t.db, args(), t.deps)
      expect(r.verdict).toBe('unknown')
      expect(t.fetchImpl.count(MOVE_PATH)).toBe(1)
    })
    it('with no known original event, "still booked elsewhere" cannot be absent: unknown, never re-sent', async () => {
      const t = await setup({ routes: { [MOVE_PATH]: [res(502, {}), ok(dto())], [BOOKING_PATH]: [ok(dto({ event_id: EVENT }))] } })
      const r = await moveBooking(t.db, args({ fromEventId: null }), t.deps)
      expect(r.verdict).toBe('unknown')
      expect(t.fetchImpl.count(MOVE_PATH)).toBe(1)
    })
    it('attended or a no-show at the original class → refused UN1T_ALREADY_HAPPENED', async () => {
      const t = await setup({ routes: { [MOVE_PATH]: [res(502, {})], [BOOKING_PATH]: [ok(dto({ event_id: EVENT, status: 'attended' }))] } })
      const r = await moveBooking(t.db, args(), t.deps)
      expect(r).toMatchObject({ verdict: 'refused', code: C.ALREADY_HAPPENED })
    })
  })

  it('a done move on the ledger the check read confirms sends nothing and is done', async () => {
    const key = `move:${LOC}:${BOOKING}:${TARGET}`
    const t = await setup({
      routes: { [BOOKING_PATH]: [ok(dto())], [CREDITS_PATH]: [credits()] },
      db: { tables: { un1t_write_events: [{ id: 'led-done', location_id: LOC, idempotency_key: key, op: 'move', stage: 'done', un1t_ref: BOOKING, created_at: ago(60_000) }] } },
    })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, sent: false, ledgerId: 'led-done' })
    expect(t.fetchImpl.writes()).toHaveLength(0)
    expect(ledger(t.store)).toHaveLength(1)
  })

  it('a done move the check read cannot confirm sends nothing and is unknown', async () => {
    const key = `move:${LOC}:${BOOKING}:${TARGET}`
    const t = await setup({
      routes: { [BOOKING_PATH]: [res(500, {})] },
      db: { tables: { un1t_write_events: [{ id: 'led-done', location_id: LOC, idempotency_key: key, op: 'move', stage: 'done', un1t_ref: BOOKING, created_at: ago(60_000) }] } },
    })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'unknown', code: UN1T_MOVE_CODES.PRIOR_MOVE_UNVERIFIED, ledgerId: 'led-done' })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it('a done move whose booking has since moved back is sent again', async () => {
    const key = `move:${LOC}:${BOOKING}:${TARGET}`
    const t = await setup({
      routes: { [BOOKING_PATH]: [ok(dto({ event_id: EVENT }))], [MOVE_PATH]: [ok(dto())], [CREDITS_PATH]: [credits()] },
      db: { tables: { un1t_write_events: [{ id: 'led-done', location_id: LOC, idempotency_key: key, op: 'move', stage: 'done', un1t_ref: BOOKING, created_at: ago(60_000) }] } },
    })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r.verdict).toBe('done')
    expect(t.fetchImpl.count(MOVE_PATH)).toBe(1)
  })

  it('writes switched off refuse before anything is sent or recorded', async () => {
    const t = await setup({ db: { settings: { un1t_online: { writes_enabled: false } } } })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.WRITES_OFF, sent: false })
    expect(t.fetchImpl.calls).toHaveLength(0)
    expect(ledger(t.store)).toHaveLength(0)
  })

  it('a token without bookings:update refuses UN1T_PERMISSION_MISSING with nothing sent', async () => {
    const t = await setup({ perms: ['bookings:read', 'bookings:create'] })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.PERMISSION_MISSING })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it('a booking the mirror holds for another client is refused UN1T_BOOKING_NOT_THIS_CLIENT, nothing sent', async () => {
    const t = await setup({ db: { tables: { un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, un1t_user_id: 'someone-else', event_id: EVENT, status: 'booked' }] } } })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.BOOKING_NOT_THIS_CLIENT, sent: false })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it('a move to the class the booking is already for is refused move_same_class, nothing sent', async () => {
    const t = await setup()
    const r = await moveBooking(t.db, args({ fromEventId: TARGET }), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: UN1T_MOVE_CODES.SAME_CLASS, sent: false })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it('takes the original event from the mirror when the caller gives none', async () => {
    const t = await setup({
      routes: { [MOVE_PATH]: [res(502, {}), ok(dto())], [BOOKING_PATH]: [ok(dto({ event_id: EVENT }))], [CREDITS_PATH]: [credits()] },
      db: { tables: { un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, un1t_user_id: USER, event_id: EVENT, status: 'booked' }] } },
    })
    const r = await moveBooking(t.db, args({ fromEventId: undefined }), t.deps)
    expect(r.verdict).toBe('done')
    expect(t.fetchImpl.count(MOVE_PATH)).toBe(2)
  })

  it('a failed mirror read rejects Un1tSettingsReadError before anything is sent', async () => {
    const t = await setup({ db: { fail: { 'un1t_bookings.select': { code: 'XX000' } } } })
    await expect(moveBooking(t.db, args(), t.deps)).rejects.toBeInstanceOf(Un1tSettingsReadError)
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it("rejects 'un1t:' ids before anything is read", async () => {
    const t = await setup()
    await expect(moveBooking(t.db, args({ eventId: `un1t:${TARGET}` }), t.deps)).rejects.toBeInstanceOf(TypeError)
    await expect(moveBooking(t.db, args({ bookingId: `un1t:${BOOKING}` }), t.deps)).rejects.toBeInstanceOf(TypeError)
    expect(t.fetchImpl.calls).toHaveLength(0)
  })

  it('when un1t.online answers a new booking id, the old row is re-read and mirrored too', async () => {
    const NEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const t = await setup({
      routes: {
        [MOVE_PATH]: [ok(dto({ id: NEW }))],
        [BOOKING_PATH]: [ok(dto({ event_id: EVENT, status: 'cancelled' }))],
        [CREDITS_PATH]: [credits()],
      },
      db: { tables: { un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, un1t_user_id: USER, event_id: EVENT, status: 'booked' }] } },
    })
    const r = await moveBooking(t.db, args(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: NEW })
    const byId = Object.fromEntries(t.store.un1t_bookings.map((b) => [b.un1t_id, b]))
    expect(byId[NEW]).toMatchObject({ event_id: TARGET, status: 'booked' })
    expect(byId[BOOKING]).toMatchObject({ status: 'cancelled' })
  })
})

describe('findMoveState', () => {
  it('reads GET /bookings/{id} and answers landed / absent / already_happened / unknown', async () => {
    const cases = [
      [dto(), 'landed'],
      [dto({ event_id: EVENT }), 'absent'],
      [dto({ event_id: EVENT, status: 'no_show' }), 'already_happened'],
      [dto({ status: 'waitlisted' }), 'unknown'],
    ]
    for (const [row, want] of cases) {
      const t = await setup({ routes: { [BOOKING_PATH]: [ok(row)] } })
      const writer = await t.deps.writerFactory(t.db, LOC)
      const got = await findMoveState(writer, { bookingId: BOOKING, un1tUserId: USER, eventId: TARGET, fromEventId: EVENT })
      expect(got.state, JSON.stringify(row)).toBe(want)
    }
  })
})

// UN1TMOVE.2 — the late-cancel window: inside it only a class the same studio
// day, and a booking moved that way is never cancelled by the CRM afterwards.
describe('the late-window rule', () => {
  const ZONE = 'Europe/Dublin'
  // The class being left: 18:30 Dublin on Fri 30 Oct (UTC+0 then).
  const FROM_AT = '2026-10-30T18:30:00.000Z'
  const events = (targetAt) => [
    { id: 'ue-1', location_id: LOC, un1t_id: EVENT, title: 'HYROX', starts_at: FROM_AT },
    { id: 'ue-2', location_id: LOC, un1t_id: TARGET, title: 'Strength', starts_at: targetAt },
  ]
  const lateDeps = (t, applies = true) => ({
    ...t.deps,
    lateQuote: vi.fn(async (_db, a) => (applies ? { applies: true, penalty: 'fee', amountCents: 1000, windowHours: 12, swapMinutes: null, _args: a } : { applies: false, reason: 'in_time' })),
    zoneOf: vi.fn(async () => ZONE),
  })

  it('inside the window, a class the same studio day moves and the ledger row says late_window', async () => {
    const t = await setup({ routes: { [MOVE_PATH]: [ok(dto())], [CREDITS_PATH]: [credits()] }, db: { tables: { un1t_events: events('2026-10-30T20:00:00.000Z') } } })
    const d = lateDeps(t)
    const r = await moveBooking(t.db, args(), d)
    expect(r.verdict).toBe('done')
    expect(ledger(t.store)[0]).toMatchObject({ op: 'move', target: BOOKING, late_window: true, stage: 'done' })
    expect(d.lateQuote.mock.calls[0][1]).toMatchObject({ locationId: LOC, un1tUserId: USER, bookingId: BOOKING, eventId: EVENT, startsAt: FROM_AT })
  })

  it('inside the window, a class on another studio day is refused move_late_other_day, nothing sent or recorded', async () => {
    const t = await setup({ routes: { [MOVE_PATH]: [ok(dto())] }, db: { tables: { un1t_events: events('2026-10-31T07:00:00.000Z') } } })
    const r = await moveBooking(t.db, args(), lateDeps(t))
    expect(r).toMatchObject({ verdict: 'refused', code: L.OTHER_DAY, sent: false, retryable: false })
    expect(r.message).toMatch(/only move to another class the same day/)
    expect(t.fetchImpl.writes()).toHaveLength(0)
    expect(ledger(t.store)).toHaveLength(0)
  })

  it('outside the window any day is fine, and the row says late_window false', async () => {
    const t = await setup({ routes: { [MOVE_PATH]: [ok(dto())], [CREDITS_PATH]: [credits()] }, db: { tables: { un1t_events: events('2026-11-05T07:00:00.000Z') } } })
    expect((await moveBooking(t.db, args(), lateDeps(t, false))).verdict).toBe('done')
    expect(ledger(t.store)[0].late_window).toBe(false)
  })

  it('a window that cannot be worked out refuses (retryable), nothing sent: a failed quote, an unknown start with fees on, a missing target start', async () => {
    for (const [name, quote, tables] of [
      ['quote throws', async () => { throw Object.assign(new Error('db'), { code: 'XX000' }) }, events('2026-10-30T20:00:00.000Z')],
      ['no start, fees on', async () => ({ applies: false, reason: 'no_start' }), []],
      ['target unknown', async () => ({ applies: true, penalty: 'fee', amountCents: 1000, windowHours: 12 }), events('x').slice(0, 1)],
    ]) {
      const t = await setup({ routes: { [MOVE_PATH]: [ok(dto())] }, db: { tables: { un1t_events: tables } } })
      const r = await moveBooking(t.db, args(), { ...t.deps, lateQuote: vi.fn(quote), zoneOf: vi.fn(async () => ZONE) })
      expect(r, name).toMatchObject({ verdict: 'refused', code: L.WINDOW_UNREADABLE, retryable: true, sent: false })
      expect(t.fetchImpl.writes(), name).toHaveLength(0)
    }
  })

  it("the real quote reads the studio's window through the writer (fees on, a pack member)", async () => {
    const settings = { un1t_online: { writes_enabled: true, fees: { enabled: true, late_cancel_fee_cents: 1000 } } }
    const soonFrom = new Date(Date.now() + 2 * 3_600_000)
    const sameDayLater = new Date(soonFrom.getTime() + 60_000)
    const t = await setup({
      routes: { [`GET /studios/${STUDIO}`]: [ok({ id: STUDIO, default_cancelation_window_hours: 12 })], [MOVE_PATH]: [ok(dto())], [CREDITS_PATH]: [credits()] },
      db: {
        settings,
        tables: {
          un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, un1t_user_id: USER, event_id: EVENT, status: 'booked', credit_charged: true }],
          un1t_events: [
            { id: 'ue-1', location_id: LOC, un1t_id: EVENT, starts_at: soonFrom.toISOString() },
            { id: 'ue-2', location_id: LOC, un1t_id: TARGET, starts_at: sameDayLater.toISOString() },
          ],
        },
      },
    })
    const r = await moveBooking(t.db, args({ fromEventId: undefined }), { ...t.deps, zoneOf: vi.fn(async () => 'UTC') })
    expect(r.verdict).toBe('done')
    expect(t.fetchImpl.count(`GET /studios/${STUDIO}`)).toBe(1)
    expect(ledger(t.store)[0].late_window).toBe(true)
  })

  describe('cancel after a late-window move', () => {
    const CANCEL_PATH = `PATCH /bookings/${BOOKING}/cancel`
    const lateRow = (over = {}) => ({ id: 'led-m', location_id: LOC, op: 'move', stage: 'done', late_window: true, target: BOOKING, un1t_ref: BOOKING, idempotency_key: `move:${LOC}:${BOOKING}:${TARGET}`, created_at: ago(60_000), ...over })
    const cancelArgs = { locationId: LOC, contactId: CONTACT, un1tUserId: USER, bookingId: BOOKING, origin: 'staff' }

    it('is refused cancel_after_late_move with nothing sent, whatever the move row stage that may have moved it', async () => {
      for (const row of [lateRow(), lateRow({ stage: 'unknown', un1t_ref: null }), lateRow({ target: 'old-bk' })]) {
        const t = await setup({ routes: { [CANCEL_PATH]: [res(200, undefined)] }, db: { tables: { un1t_write_events: [row] } } })
        const r = await cancel(t.db, cancelArgs, t.deps)
        expect(r, JSON.stringify(row)).toMatchObject({ verdict: 'refused', code: L.CANCEL_AFTER_LATE_MOVE, sent: false, retryable: false })
        expect(t.fetchImpl.writes()).toHaveLength(0)
      }
    })

    it('a move outside the window, or a refused late move, does not block the cancel', async () => {
      for (const row of [lateRow({ late_window: false }), lateRow({ stage: 'refused' })]) {
        const t = await setup({ routes: { [CANCEL_PATH]: [res(200, undefined)], [BOOKING_PATH]: [ok(dto({ status: 'cancelled' }))], [CREDITS_PATH]: [credits()] }, db: { tables: { un1t_write_events: [row] } } })
        expect((await cancel(t.db, cancelArgs, t.deps)).verdict, JSON.stringify(row)).toBe('done')
      }
    })

    it('a failed ledger read refuses the cancel (fail closed, retryable), nothing sent', async () => {
      const t = await setup({ routes: { [CANCEL_PATH]: [res(200, undefined)] } })
      // Only the late-move read fails (the done-cancel read before it works).
      const realFrom = t.db.from
      t.db.from = (name) => {
        const q = realFrom(name)
        const eq = q.eq
        q.eq = (c, v) => {
          if (c === 'late_window') q.then = (okFn, noFn) => Promise.resolve({ data: null, error: { code: 'XX000' } }).then(okFn, noFn)
          return eq(c, v)
        }
        return q
      }
      const r = await cancel(t.db, cancelArgs, t.deps)
      expect(r).toMatchObject({ verdict: 'refused', code: L.CANCEL_CHECK_UNREADABLE, retryable: true, sent: false })
      expect(t.fetchImpl.writes()).toHaveLength(0)
    })
  })
})
