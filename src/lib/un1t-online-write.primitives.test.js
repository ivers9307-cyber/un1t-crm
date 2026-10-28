import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))
vi.mock('./tenant-host.js', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))

import { logError, logWarn, logInfo } from './log'
import { recordErrorEvent } from './error-events'
import { Un1tSettingsReadError } from './un1t-online-settings.js'
import {
  createUn1tWriter,
  Un1tWriteRefused,
  Un1tWriteUnknown,
  UN1T_WRITE_CODES,
  _resetUn1tWriteStateForTests,
} from './un1t-online-write.js'
import {
  book,
  cancel,
  createClient,
  forgotPassword,
  createCheckoutLink,
  findLandedBooking,
  findCancelState,
  findClientByEmail,
  findDoneBooking,
  findDoneTrial,
} from './un1t-online-write-ops.js'
import {
  LOC, ORG, STUDIO, TOKEN, EVENT, USER, BOOKING, PRODUCT, NEW_USER, CONTACT, OTHER_CONTACT,
  ALLOWED_LOG_FIELDS, res, created, ok, page, makeFetch, makeDb, selfRes,
} from './un1t-online-write.test-helpers.js'

const C = UN1T_WRITE_CODES
const EMAIL = 'person.test@example.test'
const PHONE = '+353800000000'
const CREDITS_PATH = `GET /credits/ledgers/${USER}/${STUDIO}`
const USER_BOOKINGS = `GET /users/${USER}/bookings`
const BOOKING_PATH = `GET /bookings/${BOOKING}`
const CANCEL_PATH = `PATCH /bookings/${BOOKING}/cancel`
const CONTRACT_KEYS = ['verdict', 'sent', 'id', 'code', 'message', 'alreadyBooked', 'recovered', 'retryable', 'data', 'ledgerId'].sort()
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const soon = (ms = 5_000) => new Date(Date.now() + ms).toISOString()
const LONG_AGO = '2026-01-05T09:00:00.000Z'

async function setup({ routes = {}, db: dbOpts = {} } = {}) {
  const made = makeDb(dbOpts)
  const fetchImpl = makeFetch({ 'GET /api-token': [selfRes()], ...routes })
  const sleep = vi.fn(async () => {})
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep }))
  const deps = { writerFactory, now: () => new Date() }
  return { ...made, fetchImpl, sleep, deps }
}

const bookingDto = (over = {}) => ({
  id: BOOKING, event_id: EVENT, user_id: USER, studio_id: STUDIO, status: 'booked',
  created_at: soon(), updated_at: soon(), ...over,
})
const bookArgs = (over = {}) => ({ locationId: LOC, contactId: CONTACT, un1tUserId: USER, eventId: EVENT, origin: 'staff', actor: { id: 'staff-1' }, ...over })
const cancelArgs = (over = {}) => ({ locationId: LOC, contactId: CONTACT, un1tUserId: USER, bookingId: BOOKING, origin: 'staff', ...over })
const contact = (over = {}) => ({ id: CONTACT, email: EMAIL, first_name: 'Test', last_name: 'Person', name: 'Test Person', phone: PHONE, ...over })
const terms = { acceptedAt: '2026-10-18T09:00:00.000Z', source: 'website', version: 'v1' }
const createArgs = (over = {}) => ({ locationId: LOC, contact: contact(), terms, origin: 'funnel', originRef: 'cbr-1', ...over })
const pwArgs = (over = {}) => ({ locationId: LOC, contactId: CONTACT, un1tUserId: USER, email: EMAIL, origin: 'funnel', ...over })
const checkoutArgs = (over = {}) => ({
  locationId: LOC, userId: USER, productId: PRODUCT,
  successUrl: 'https://hatch.example.test/pay-done/tok-1', cancelUrl: 'https://hatch.example.test/pay-done/tok-1?c=1',
  idempotencyKey: 'intent-1', ...over,
})
const checkoutTables = (product = {}) => ({
  un1t_clients: [{ id: 'cl-1', location_id: LOC, un1t_user_id: USER }],
  un1t_products: [{ id: 'pr-1', location_id: LOC, un1t_id: PRODUCT, status: 'active', price_cents: 2000, ...product }],
})
const credits = () => ok({ balance: 4, is_unlimited: false })
const clientRow = () => ({ id: 'cl-1', location_id: LOC, un1t_user_id: USER, credit_balance: 5, credit_unlimited: false, crm_written_at: null })

const allLogs = () => [...logInfo.mock.calls, ...logWarn.mock.calls, ...logError.mock.calls]
const writeLogs = () => allLogs().filter(([mod]) => mod === 'un1t-online-write')
const ledger = (store) => store.un1t_write_events

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
})

describe('book', () => {
  it('book sends exactly { eventId, userId } and never bypassCredit', async () => {
    const t = await setup({ routes: { 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [credits()] } })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r.verdict).toBe('done')
    const [post] = t.fetchImpl.writes()
    expect(post.body).toEqual({ eventId: EVENT, userId: USER })
    expect(Object.keys(post.body)).not.toContain('bypassCredit')
    expect(t.fetchImpl.writes()).toHaveLength(1)
  })

  it('book done upserts un1t_bookings with crm_written_at, refreshes credits and returns the mapped row', async () => {
    const t = await setup({
      routes: { 'POST /bookings': [created(bookingDto({ guest_name: 'A Guest', guest_email: 'guest@example.test' }))], [CREDITS_PATH]: [credits()] },
      db: { tables: { un1t_clients: [clientRow()] } },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, sent: true, alreadyBooked: false, retryable: false })
    const [row] = t.store.un1t_bookings
    expect(row).toMatchObject({ location_id: LOC, un1t_id: BOOKING, un1t_user_id: USER, event_id: EVENT, status: 'booked', contact_id: CONTACT })
    expect(row.crm_written_at).toEqual(expect.any(String))
    // The guest flag comes from the result's data, never re-derived (the pick drops guest fields).
    expect(row.has_guest).toBe(true)
    expect(JSON.stringify(row)).not.toContain('guest@example.test')
    expect(r.data).toMatchObject({ un1t_id: BOOKING, status: 'booked', has_guest: true, crm_written_at: row.crm_written_at })
    // Credits refresh stamps crm_written_at too.
    expect(t.store.un1t_clients[0]).toMatchObject({ credit_balance: 4, credit_unlimited: false })
    expect(t.store.un1t_clients[0].crm_written_at).toEqual(expect.any(String))
    expect(t.fetchImpl.count(CREDITS_PATH)).toBe(1)
    expect(ledger(t.store)[0]).toMatchObject({ op: 'book', stage: 'done', un1t_ref: BOOKING, idempotency_key: `book:${LOC}:${USER}:${EVENT}`, target: EVENT, actor_user_id: 'staff-1' })
    expect(r.ledgerId).toBe(ledger(t.store)[0].id)
  })

  it('UN1TWRITE.11: book done writes the class_bookings row with written_by crm and the answer\'s updated_at', async () => {
    const answer = bookingDto({ updated_at: '2026-10-18T09:59:59.000Z' })
    const t = await setup({
      routes: { 'POST /bookings': [created(answer)], [CREDITS_PATH]: [credits()] },
      db: { tables: {
        un1t_events: [{ id: 'ue-1', location_id: LOC, un1t_id: EVENT, title: 'HYROX', starts_at: '2026-10-20T17:30:00.000Z' }],
        contacts: [{ id: CONTACT, organization_id: ORG, name: 'Test Person', un1t_user_id: USER }],
      } },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r.verdict).toBe('done')
    expect(t.store.class_bookings).toHaveLength(1)
    expect(t.store.class_bookings[0]).toMatchObject({
      location_id: LOC, glofox_booking_id: `un1t:${BOOKING}`, glofox_event_id: `un1t:${EVENT}`, source_platform: 'un1t_online',
      contact_id: CONTACT, member_name: 'Test Person', status: 'BOOKED', attended: false,
      raw: { un1t: { written_by: 'crm', updated_at: '2026-10-18T09:59:59.000Z' } },
    })
  })

  it('book already booked is done with alreadyBooked true and a done ledger row', async () => {
    const t = await setup({
      routes: {
        'POST /bookings': [res(409, { success: false, error: { code: 'BOOKING_EXISTS', message: 'This user is already booked for this event' } })],
        [USER_BOOKINGS]: [page([bookingDto({ created_at: LONG_AGO })])],
        [CREDITS_PATH]: [credits()],
      },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', alreadyBooked: true, id: BOOKING })
    expect(t.fetchImpl.writes()).toHaveLength(1)
    expect(ledger(t.store)).toHaveLength(1)
    expect(ledger(t.store)[0].stage).toBe('done')
  })

  it('an already-booked hint the check read cannot confirm is unknown already_booked_unverified, never re-sent', async () => {
    const t = await setup({
      routes: {
        'POST /bookings': [res(409, { success: false, error: { code: 'BOOKING_EXISTS', message: 'already booked' } })],
        [USER_BOOKINGS]: [page([bookingDto({ status: 'waitlisted', created_at: LONG_AGO })])],
      },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'unknown', code: C.ALREADY_BOOKED_UNVERIFIED, alreadyBooked: false })
    expect(t.fetchImpl.writes()).toHaveLength(1)
    expect(ledger(t.store)[0]).toMatchObject({ stage: 'unknown', code: C.ALREADY_BOOKED_UNVERIFIED })
  })

  describe('book 5xx: the dedupe read counts a booked row for this event created since the send, or an older booked one, as landed; only cancelled rows as absent; anything else as unknown', () => {
    const cases = [
      ['booked since the send', [bookingDto()], 'landed'],
      ['attended since the send', [bookingDto({ status: 'attended' })], 'landed'],
      ['an older booked one', [bookingDto({ created_at: LONG_AGO })], 'landed'],
      ['an older attended one', [bookingDto({ status: 'attended', created_at: LONG_AGO })], 'unknown'],
      ['a waitlist entry', [bookingDto({ status: 'waitlisted' })], 'unknown'],
      ['only cancelled rows', [bookingDto({ status: 'cancelled', created_at: LONG_AGO })], 'absent'],
      ['no row for this event', [bookingDto({ event_id: 'event-other' })], 'absent'],
    ]
    for (const [name, rows, want] of cases) {
      it(name, async () => {
        const t = await setup({
          routes: {
            'POST /bookings': [res(503, {}), created(bookingDto())],
            [USER_BOOKINGS]: [page(rows)],
            [CREDITS_PATH]: [credits()],
          },
        })
        const r = await book(t.db, bookArgs(), t.deps)
        const posts = t.fetchImpl.count('POST /bookings')
        if (want === 'landed') {
          expect(r).toMatchObject({ verdict: 'done', recovered: 'landed_after_5xx', id: BOOKING })
          expect(posts).toBe(1)
          expect(t.store.un1t_bookings).toHaveLength(1)
        } else if (want === 'absent') {
          expect(r).toMatchObject({ verdict: 'done', id: BOOKING })
          expect(posts).toBe(2)
        } else {
          expect(r.verdict).toBe('unknown')
          expect(posts).toBe(1)
          expect(ledger(t.store)[0].stage).toBe('unknown')
        }
      })
    }

    it('a failed read is unknown, and nothing is re-sent', async () => {
      const t = await setup({ routes: { 'POST /bookings': [res(503, {})], [USER_BOOKINGS]: [res(500, {})] } })
      const r = await book(t.db, bookArgs(), t.deps)
      expect(r.verdict).toBe('unknown')
      expect(t.fetchImpl.count('POST /bookings')).toBe(1)
    })
  })

  it('a second book while the first sent row is under 3 minutes old is UN1T_ATTEMPT_IN_FLIGHT and sends nothing', async () => {
    const key = `book:${LOC}:${USER}:${EVENT}`
    const t = await setup({ db: { tables: { un1t_write_events: [{ id: 'led-old', location_id: LOC, idempotency_key: key, op: 'book', stage: 'sent', created_at: ago(30_000) }] } } })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.ATTEMPT_IN_FLIGHT, retryable: true, sent: false, ledgerId: 'led-old' })
    expect(t.fetchImpl.writes()).toHaveLength(0)
    expect(t.fetchImpl.count(USER_BOOKINGS)).toBe(0)
  })

  it('an older unknown book row is resolved by the dedupe read before any new send (landed: done, mirrored, nothing sent)', async () => {
    const key = `book:${LOC}:${USER}:${EVENT}`
    const t = await setup({
      routes: { [USER_BOOKINGS]: [page([bookingDto({ created_at: LONG_AGO })])], [CREDITS_PATH]: [credits()] },
      db: { tables: { un1t_write_events: [{ id: 'led-old', location_id: LOC, idempotency_key: key, op: 'book', stage: 'unknown', created_at: ago(10 * 60_000) }] } },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, recovered: 'landed_on_resume', ledgerId: 'led-old', sent: false })
    expect(t.fetchImpl.writes()).toHaveLength(0)
    expect(ledger(t.store)).toHaveLength(1)
    expect(ledger(t.store)[0]).toMatchObject({ stage: 'done', un1t_ref: BOOKING })
    expect(t.store.un1t_bookings[0]).toMatchObject({ un1t_id: BOOKING, status: 'booked' })
    expect(r.data).toMatchObject({ un1t_id: BOOKING })
  })

  it('an older unknown book row the dedupe read finds absent is closed, then one fresh send', async () => {
    const key = `book:${LOC}:${USER}:${EVENT}`
    const t = await setup({
      routes: { [USER_BOOKINGS]: [page([])], 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [credits()] },
      db: { tables: { un1t_write_events: [{ id: 'led-old', location_id: LOC, idempotency_key: key, op: 'book', stage: 'unknown', created_at: ago(10 * 60_000) }] } },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r.verdict).toBe('done')
    expect(t.fetchImpl.writes()).toHaveLength(1)
    const old = ledger(t.store).find((x) => x.id === 'led-old')
    expect(old).toMatchObject({ stage: 'refused', code: 'not_landed' })
    expect(r.ledgerId).not.toBe('led-old')
  })

  it("rejects an event id carrying the 'un1t:' prefix before anything is read", async () => {
    const t = await setup()
    await expect(book(t.db, bookArgs({ eventId: `un1t:${EVENT}` }), t.deps)).rejects.toBeInstanceOf(TypeError)
    expect(t.deps.writerFactory).not.toHaveBeenCalled()
  })
})

describe('cancel', () => {
  it('cancel sends an empty body (never forceRefund) and re-reads the booking for the mirror', async () => {
    const t = await setup({
      routes: {
        [CANCEL_PATH]: [res(200, undefined)],
        [BOOKING_PATH]: [ok(bookingDto({ status: 'cancelled', guest_phone: '+353811111111' }))],
        [CREDITS_PATH]: [credits()],
      },
      db: { tables: { un1t_clients: [clientRow()] } },
    })
    const r = await cancel(t.db, cancelArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING })
    const [patch] = t.fetchImpl.writes()
    expect(patch.body).toEqual({})
    expect(t.fetchImpl.count(BOOKING_PATH)).toBe(1)
    const [row] = t.store.un1t_bookings
    expect(row).toMatchObject({ un1t_id: BOOKING, status: 'cancelled', contact_id: CONTACT, has_guest: true })
    expect(row.crm_written_at).toEqual(expect.any(String))
    expect(JSON.stringify(row)).not.toContain('811111111')
    expect(t.store.un1t_clients[0].credit_balance).toBe(4)
    expect(r.data).toMatchObject({ un1t_id: BOOKING, status: 'cancelled' })
    expect(ledger(t.store)[0]).toMatchObject({ op: 'cancel', stage: 'done', un1t_ref: BOOKING, target: BOOKING, idempotency_key: `cancel:${LOC}:${BOOKING}` })
  })

  it('UN1TWRITE.11: cancel done turns the same class_bookings key CANCELLED', async () => {
    const t = await setup({
      routes: {
        [CANCEL_PATH]: [res(200, undefined)],
        [BOOKING_PATH]: [ok(bookingDto({ status: 'cancelled', updated_at: '2026-10-18T10:00:01.000Z' }))],
        [CREDITS_PATH]: [credits()],
      },
      db: { tables: {
        un1t_events: [{ id: 'ue-1', location_id: LOC, un1t_id: EVENT, title: 'HYROX', starts_at: '2026-10-20T17:30:00.000Z' }],
        class_bookings: [{ id: 'cb-1', location_id: LOC, glofox_booking_id: `un1t:${BOOKING}`, source_platform: 'un1t_online', status: 'BOOKED', attended: false, raw: { un1t: { written_by: 'sync' } } }],
      } },
    })
    const r = await cancel(t.db, cancelArgs(), t.deps)
    expect(r.verdict).toBe('done')
    expect(t.store.class_bookings).toHaveLength(1)
    expect(t.store.class_bookings[0]).toMatchObject({ id: 'cb-1', status: 'CANCELLED', raw: { un1t: { status: 'cancelled', written_by: 'crm', updated_at: '2026-10-18T10:00:01.000Z' } } })
  })

  describe('cancel dedupe: cancelled landed, booked absent, attended or no_show refused already_happened', () => {
    it('cancelled → landed', async () => {
      const t = await setup({ routes: { [CANCEL_PATH]: [res(502, {})], [BOOKING_PATH]: [ok(bookingDto({ status: 'cancelled' }))], [CREDITS_PATH]: [credits()] } })
      const r = await cancel(t.db, cancelArgs(), t.deps)
      expect(r).toMatchObject({ verdict: 'done', recovered: 'landed_after_5xx', id: BOOKING })
      expect(t.fetchImpl.count(CANCEL_PATH)).toBe(1)
    })
    it('booked → absent, re-sent once', async () => {
      const t = await setup({
        routes: {
          [CANCEL_PATH]: [res(502, {}), res(200, undefined)],
          [BOOKING_PATH]: [ok(bookingDto()), ok(bookingDto({ status: 'cancelled' }))],
          [CREDITS_PATH]: [credits()],
        },
      })
      const r = await cancel(t.db, cancelArgs(), t.deps)
      expect(r.verdict).toBe('done')
      expect(t.fetchImpl.count(CANCEL_PATH)).toBe(2)
    })
    for (const status of ['attended', 'no_show']) {
      it(`${status} → refused ${C.ALREADY_HAPPENED}`, async () => {
        const t = await setup({ routes: { [CANCEL_PATH]: [res(502, {})], [BOOKING_PATH]: [ok(bookingDto({ status }))] } })
        const r = await cancel(t.db, cancelArgs(), t.deps)
        expect(r).toMatchObject({ verdict: 'refused', code: C.ALREADY_HAPPENED, retryable: false })
        expect(t.fetchImpl.count(CANCEL_PATH)).toBe(1)
        expect(ledger(t.store)[0]).toMatchObject({ stage: 'refused', code: C.ALREADY_HAPPENED })
        expect(t.store.un1t_bookings).toHaveLength(0)
      })
    }
  })

  it('a stale cancel row whose booking is already cancelled is landed on resume (not already happened)', async () => {
    const key = `cancel:${LOC}:${BOOKING}`
    const t = await setup({
      routes: { [BOOKING_PATH]: [ok(bookingDto({ status: 'cancelled' }))], [CREDITS_PATH]: [credits()] },
      db: { tables: { un1t_write_events: [{ id: 'led-old', location_id: LOC, idempotency_key: key, op: 'cancel', stage: 'sent', created_at: ago(10 * 60_000) }] } },
    })
    const r = await cancel(t.db, cancelArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', recovered: 'landed_on_resume', id: BOOKING })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it("a booking the mirror holds for another client is refused UN1T_BOOKING_NOT_THIS_CLIENT with nothing sent (minor 1)", async () => {
    expect(C.BOOKING_NOT_THIS_CLIENT).toBe('UN1T_BOOKING_NOT_THIS_CLIENT')
    const t = await setup({ routes: { [CANCEL_PATH]: [res(200, undefined)] }, db: { tables: { un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, un1t_user_id: 'someone-else', status: 'booked' }] } } })
    const r = await cancel(t.db, cancelArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.BOOKING_NOT_THIS_CLIENT, sent: false, retryable: false, ledgerId: null })
    expect(t.fetchImpl.writes()).toHaveLength(0)
    expect(ledger(t.store)).toHaveLength(0)
  })

  it('an answer that names another client is unknown UN1T_BOOKING_NOT_THIS_CLIENT, never done (minor 1)', async () => {
    const t = await setup({ routes: { [CANCEL_PATH]: [ok(bookingDto({ status: 'cancelled', user_id: 'someone-else' }))], [BOOKING_PATH]: [ok(bookingDto({ status: 'cancelled' }))], [CREDITS_PATH]: [credits()] } })
    const r = await cancel(t.db, cancelArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'unknown', code: C.BOOKING_NOT_THIS_CLIENT })
    expect(ledger(t.store)[0]).toMatchObject({ stage: 'unknown', code: C.BOOKING_NOT_THIS_CLIENT })
    expect(t.store.un1t_bookings).toHaveLength(0)
  })

  it("a check read naming another client is unknown: never landed, never re-sent (minor 1)", async () => {
    const t = await setup({ routes: { [CANCEL_PATH]: [res(502, {}), res(200, undefined)], [BOOKING_PATH]: [ok(bookingDto({ user_id: 'someone-else' }))] } })
    const r = await cancel(t.db, cancelArgs(), t.deps)
    expect(r.verdict).toBe('unknown')
    expect(t.fetchImpl.count(CANCEL_PATH)).toBe(1)
    const { writer } = { writer: await t.deps.writerFactory(t.db, LOC) }
    await expect(findCancelState(writer, { bookingId: BOOKING, un1tUserId: USER })).resolves.toBe('unknown')
  })

  it('a failed mirror read before a cancel rejects Un1tSettingsReadError, nothing sent', async () => {
    const t = await setup({ db: { fail: { 'un1t_bookings.select': { code: 'XX000' } } } })
    await expect(cancel(t.db, cancelArgs(), t.deps)).rejects.toBeInstanceOf(Un1tSettingsReadError)
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it('a done cancel row for the booking sends nothing and returns done', async () => {
    const key = `cancel:${LOC}:${BOOKING}`
    const t = await setup({ db: { tables: { un1t_write_events: [{ id: 'led-done', location_id: LOC, idempotency_key: key, op: 'cancel', stage: 'done', un1t_ref: BOOKING, created_at: ago(60_000) }] } } })
    const r = await cancel(t.db, cancelArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING, sent: false, ledgerId: 'led-done' })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })
})

describe('createClient', () => {
  const createRoutes = (over = {}) => ({ 'POST /users/clients': [created({ id: NEW_USER })], ...over })
  const contactsTable = (extra = []) => ({ contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null }, ...extra] })

  it('createClient sends accepted_terms and accepted_liability_waiver true and a 32-character password', async () => {
    const t = await setup({ routes: createRoutes(), db: { tables: contactsTable() } })
    const r = await createClient(t.db, createArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: NEW_USER, data: null })
    const [post] = t.fetchImpl.writes()
    expect(post.body).toMatchObject({
      email: EMAIL, studioId: STUDIO, name: 'Test Person', first_name: 'Test', last_name: 'Person', phone: PHONE,
      accepted_terms: true, accepted_liability_waiver: true,
    })
    expect(post.body.password).toHaveLength(32)
    expect(post.body.password).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(ledger(t.store)[0]).toMatchObject({ op: 'create_client', stage: 'done', un1t_ref: NEW_USER, terms_accepted_at: terms.acceptedAt, terms_source: 'website', idempotency_key: `create:${LOC}:${CONTACT}` })
  })

  it('omits the optional body keys it does not have (never an undefined value)', async () => {
    const t = await setup({ routes: createRoutes(), db: { tables: contactsTable() } })
    await createClient(t.db, createArgs({ contact: contact({ last_name: null, phone: undefined, name: '  ' }) }), t.deps)
    const [post] = t.fetchImpl.writes()
    expect(Object.keys(post.body).sort()).toEqual(['accepted_liability_waiver', 'accepted_terms', 'email', 'first_name', 'password', 'studioId'])
  })

  it('a fresh password every call', async () => {
    const t = await setup({ routes: createRoutes(), db: { tables: contactsTable([{ id: OTHER_CONTACT, organization_id: ORG, un1t_user_id: null }]) } })
    await createClient(t.db, createArgs(), t.deps)
    await createClient(t.db, createArgs({ contact: contact({ id: OTHER_CONTACT }) }), t.deps)
    const [a, b] = t.fetchImpl.writes()
    expect(a.body.password).not.toBe(b.body.password)
  })

  it('createClient without a recorded acceptance refuses terms_not_accepted and sends nothing', async () => {
    for (const bad of [null, {}, { acceptedAt: null, source: 'website' }, { acceptedAt: 'not a date' }]) {
      const t = await setup({ routes: createRoutes() })
      const r = await createClient(t.db, createArgs({ terms: bad }), t.deps)
      expect(r).toMatchObject({ verdict: 'refused', code: 'terms_not_accepted', sent: false, retryable: false, ledgerId: null })
      expect(t.fetchImpl).not.toHaveBeenCalled()
      expect(ledger(t.store)).toHaveLength(0)
    }
  })

  it('createClient never lets the response body out (RF1)', async () => {
    const secretBits = []
    const capture = (req) => { secretBits.push(req.body.password); return { success: true, data: { id: NEW_USER, email: EMAIL, phone: PHONE, reset_password_token: 'RPT-SECRET', first_name: 'Test' } } }
    const refusal = (req) => { secretBits.push(req.body.password); return { success: false, error: { code: 'BAD', message: `Bad input for ${EMAIL} / ${req.body.password} / 0800000000` } } }
    const failed = (req) => { secretBits.push(req.body.password); return { error: { message: `RPT-SECRET ${EMAIL}` } } }
    const results = []
    const errors = []

    const a = await setup({ routes: createRoutes({ 'POST /users/clients': [res(201, capture)] }), db: { tables: contactsTable() } })
    results.push(await createClient(a.db, createArgs(), a.deps))
    const b = await setup({ routes: createRoutes({ 'POST /users/clients': [res(400, refusal)] }), db: { tables: contactsTable() } })
    results.push(await createClient(b.db, createArgs(), b.deps))
    const c = await setup({
      routes: createRoutes({ 'POST /users/clients': [res(503, failed)], 'GET /users/clients': [res(500, {})] }),
      db: { tables: contactsTable() },
    })
    results.push(await createClient(c.db, createArgs(), c.deps))
    try { await createClient(c.db, createArgs({ contact: contact({ email: '' }) }), c.deps) } catch (e) { errors.push(e) }

    expect(results[0]).toMatchObject({ verdict: 'done', id: NEW_USER, data: null })
    expect(results[1].verdict).toBe('refused')
    expect(results[2].verdict).toBe('unknown')
    expect(secretBits).toHaveLength(3)
    const haystack = JSON.stringify({
      results, errors: errors.map((e) => ({ m: e.message, s: e.stack })),
      ledgers: [a, b, c].map((t) => ledger(t.store)), clients: [a, b, c].map((t) => t.store.un1t_clients),
      logs: allLogs(), events: recordErrorEvent.mock.calls,
    })
    for (const needle of ['RPT-SECRET', EMAIL, PHONE, '800000000', ...secretBits]) expect(haystack).not.toContain(needle)
  })

  describe('createClient 5xx: one email match is landed with the id recovered; none re-sends once; several or a failed walk is unknown', () => {
    const walk = (rows) => ({ 'GET /users/clients': [page(rows)] })
    it('one match (trimmed, lower-cased, exact; a look-alike is not a match) → landed', async () => {
      const t = await setup({
        routes: createRoutes({ 'POST /users/clients': [res(503, {})], ...walk([{ id: NEW_USER, email: '  Person.Test@Example.TEST ' }, { id: 'u-x', email: 'person_test@example.test' }]) }),
        db: { tables: contactsTable() },
      })
      const r = await createClient(t.db, createArgs(), t.deps)
      expect(r).toMatchObject({ verdict: 'done', id: NEW_USER, recovered: 'landed_after_5xx' })
      expect(t.fetchImpl.count('POST /users/clients')).toBe(1)
      expect(t.store.contacts[0].un1t_user_id).toBe(NEW_USER)
    })
    it('none → re-sent once', async () => {
      const t = await setup({ routes: createRoutes({ 'POST /users/clients': [res(503, {}), created({ id: NEW_USER })], ...walk([{ id: 'u-x', email: 'other@example.test' }]) }), db: { tables: contactsTable() } })
      const r = await createClient(t.db, createArgs(), t.deps)
      expect(r).toMatchObject({ verdict: 'done', id: NEW_USER })
      expect(t.fetchImpl.count('POST /users/clients')).toBe(2)
    })
    it('several → unknown', async () => {
      const t = await setup({ routes: createRoutes({ 'POST /users/clients': [res(503, {})], ...walk([{ id: 'u-1', email: EMAIL }, { id: 'u-2', email: EMAIL.toUpperCase() }]) }), db: { tables: contactsTable() } })
      const r = await createClient(t.db, createArgs(), t.deps)
      expect(r.verdict).toBe('unknown')
      expect(t.fetchImpl.count('POST /users/clients')).toBe(1)
    })
    it('a failed walk → unknown', async () => {
      const t = await setup({ routes: createRoutes({ 'POST /users/clients': [res(503, {})], 'GET /users/clients': [res(500, {})] }), db: { tables: contactsTable() } })
      const r = await createClient(t.db, createArgs(), t.deps)
      expect(r.verdict).toBe('unknown')
      expect(t.fetchImpl.count('POST /users/clients')).toBe(1)
      expect(ledger(t.store)[0].stage).toBe('unknown')
    })
    it('the walk never puts the email in a URL', async () => {
      const t = await setup({ routes: createRoutes({ 'POST /users/clients': [res(503, {})], ...walk([]) }), db: { tables: contactsTable() } })
      await createClient(t.db, createArgs(), t.deps)
      for (const call of t.fetchImpl.calls) expect(call.url.toLowerCase()).not.toContain('example.test')
    })
  })

  it('createClient done links contacts.un1t_user_id only where null; a 23505 returns conflict un1t_link_conflict and overwrites nothing', async () => {
    const a = await setup({ routes: createRoutes(), db: { tables: contactsTable() } })
    const r1 = await createClient(a.db, createArgs(), a.deps)
    expect(r1).toMatchObject({ verdict: 'done', id: NEW_USER, conflict: null })
    expect(a.store.contacts[0].un1t_user_id).toBe(NEW_USER)
    const link = a.calls.find((c) => c.table === 'contacts' && c.op === 'update')
    expect(link.filters).toEqual(expect.arrayContaining([['eq', 'id', CONTACT], ['is', 'un1t_user_id', null]]))
    expect(a.store.un1t_clients[0]).toMatchObject({ location_id: LOC, un1t_user_id: NEW_USER, contact_id: CONTACT })
    expect(a.store.un1t_clients[0].crm_written_at).toEqual(expect.any(String))

    const b = await setup({ routes: createRoutes(), db: { tables: contactsTable([{ id: OTHER_CONTACT, organization_id: ORG, un1t_user_id: NEW_USER }]) } })
    const r2 = await createClient(b.db, createArgs(), b.deps)
    expect(r2).toMatchObject({ verdict: 'done', id: NEW_USER, conflict: 'un1t_link_conflict' })
    expect(b.store.contacts.find((x) => x.id === CONTACT).un1t_user_id).toBeNull()
    expect(b.store.contacts.find((x) => x.id === OTHER_CONTACT).un1t_user_id).toBe(NEW_USER)
    expect(b.store.un1t_clients[0].contact_id).toBeUndefined()
  })

  it('a done create row for the contact sends nothing and returns its id', async () => {
    const key = `create:${LOC}:${CONTACT}`
    const t = await setup({ db: { tables: { un1t_write_events: [{ id: 'led-c', location_id: LOC, idempotency_key: key, op: 'create_client', stage: 'done', un1t_ref: NEW_USER, created_at: ago(60_000) }] } } })
    const r = await createClient(t.db, createArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: NEW_USER, sent: false, ledgerId: 'led-c' })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })
})

describe('createClient fix round 1', () => {
  it('the done-row short-circuit re-runs the (idempotent) mirror, so a failed contact link is retried (minor 2)', async () => {
    const key = `create:${LOC}:${CONTACT}`
    const doneRow = { id: 'led-c', location_id: LOC, idempotency_key: key, op: 'create_client', stage: 'done', un1t_ref: NEW_USER, created_at: ago(60_000) }
    const a = await setup({ db: { tables: { un1t_write_events: [doneRow], contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null }] } } })
    const r1 = await createClient(a.db, createArgs(), a.deps)
    expect(r1).toMatchObject({ verdict: 'done', id: NEW_USER, sent: false, ledgerId: 'led-c', conflict: null })
    expect(a.store.contacts[0].un1t_user_id).toBe(NEW_USER)
    expect(a.store.un1t_clients[0]).toMatchObject({ un1t_user_id: NEW_USER, contact_id: CONTACT })
    expect(a.fetchImpl.writes()).toHaveLength(0)

    const b = await setup({ db: { tables: { un1t_write_events: [doneRow], contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null }, { id: OTHER_CONTACT, organization_id: ORG, un1t_user_id: NEW_USER }] } } })
    const r2 = await createClient(b.db, createArgs(), b.deps)
    expect(r2).toMatchObject({ verdict: 'done', id: NEW_USER, conflict: 'un1t_link_conflict' })
    expect(b.store.contacts[0].un1t_user_id).toBeNull()
  })
})

describe('forgotPassword', () => {
  it('forgotPassword is never re-sent: a 5xx is unknown after one request', async () => {
    const t = await setup({ routes: { 'POST /auth/forgot-password': [res(503, {}), ok({ message: 'sent' })] } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r.verdict).toBe('unknown')
    expect(t.fetchImpl.count('POST /auth/forgot-password')).toBe(1)
    expect(ledger(t.store)[0]).toMatchObject({ op: 'forgot_password', stage: 'unknown', idempotency_key: `pw:${LOC}:${USER}:1` })
  })

  it('sends exactly { email }, records done, and keeps the address out of the ledger and the logs', async () => {
    const t = await setup({ routes: { 'POST /auth/forgot-password': [ok({ message: `We emailed ${EMAIL}` })] } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', data: null })
    expect(t.fetchImpl.writes()[0].body).toEqual({ email: EMAIL })
    expect(ledger(t.store)[0].stage).toBe('done')
    expect(JSON.stringify([ledger(t.store), allLogs(), r])).not.toContain(EMAIL)
  })
})

describe('UN1TWRITE.25 — up to 3 password resets per person per 30 minutes', () => {
  const MIN = 60_000
  const pwRow = (n, stage, ageMs, over = {}) => ({
    id: `led-pw-${n}-${stage}`, location_id: LOC, un1t_user_id: USER, op: 'forgot_password', origin: 'staff',
    idempotency_key: n == null ? `pw:${LOC}:${USER}` : `pw:${LOC}:${USER}:${n}`, stage, created_at: ago(ageMs), finished_at: ago(ageMs), ...over,
  })
  const sends = (t) => t.fetchImpl.count('POST /auth/forgot-password')
  const okRoute = () => ({ 'POST /auth/forgot-password': [ok({ message: 'sent' })] })
  // A db whose FIRST reset-allowance read (by user, not by key) answers `rows`
  // (a caller that read the ledger earlier and stalled); every other call is real.
  const staleFirstRead = (t, rows = []) => {
    let served = false
    return {
      from(name) {
        const real = t.db.from(name)
        const f = []
        const api = new Proxy(real, {
          get(target, prop) {
            if (prop === 'then' && !served) {
              const isAllowanceRead = name === 'un1t_write_events' && f.some(([c, v]) => c === 'un1t_user_id' && v === USER) && !f.some(([c]) => c === 'idempotency_key')
              if (isAllowanceRead) {
                served = true
                return (okFn, noFn) => Promise.resolve({ data: rows, error: null }).then(okFn, noFn)
              }
            }
            const v = target[prop]
            if (typeof v !== 'function') return v
            return (...args) => {
              if (prop === 'eq') f.push(args)
              const out = v.apply(target, args)
              return out === target ? api : out
            }
          },
        })
        return api
      },
      rpc: t.db.rpc,
    }
  }

  it('the 1st, 2nd and 3rd reset in 30 minutes each send, each under its own key', async () => {
    const t = await setup({ routes: okRoute() })
    for (let i = 1; i <= 3; i += 1) {
      const r = await forgotPassword(t.db, pwArgs(), t.deps)
      expect(r).toMatchObject({ verdict: 'done', sent: true })
      expect(sends(t)).toBe(i)
    }
    expect(ledger(t.store).map((r) => [r.idempotency_key, r.stage])).toEqual([
      [`pw:${LOC}:${USER}:1`, 'done'], [`pw:${LOC}:${USER}:2`, 'done'], [`pw:${LOC}:${USER}:3`, 'done'],
    ])
  })

  it('the 4th within 30 minutes is refused reset_limit, sends nothing, writes no row, and says when the next is allowed', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [pwRow(1, 'done', 25 * MIN), pwRow(2, 'done', 10 * MIN), pwRow(3, 'done', 5 * MIN)] } } })
    const before = Date.now()
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS)
    expect(r).toMatchObject({ verdict: 'refused', sent: false, code: 'reset_limit', retryable: false, ledgerId: null })
    const next = Date.parse(r.data.nextAllowedAt)
    // The oldest of the three (25 minutes ago) ages out in 5 minutes.
    expect(next).toBeGreaterThanOrEqual(before + 5 * MIN - 2_000)
    expect(next).toBeLessThanOrEqual(Date.now() + 5 * MIN + 2_000)
    expect(r.message).toMatch(/3 password reset emails in the last 30 minutes/)
    expect(r.message).toMatch(/in 5 minutes/)
    expect(r.message).not.toMatch(/—|UN1T/)
    expect(sends(t)).toBe(0)
    expect(ledger(t.store)).toHaveLength(3)
  })

  it('once the oldest of the three is older than 30 minutes, a reset sends again under the next key', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [pwRow(1, 'done', 31 * MIN), pwRow(2, 'done', 10 * MIN), pwRow(3, 'done', 5 * MIN)] } } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', sent: true })
    expect(sends(t)).toBe(1)
    expect(ledger(t.store).at(-1)).toMatchObject({ idempotency_key: `pw:${LOC}:${USER}:4`, stage: 'done' })
  })

  it('an unknown reset counts toward the 3 (it may have sent an email)', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [pwRow(1, 'done', 20 * MIN), pwRow(2, 'unknown', 15 * MIN), pwRow(3, 'done', 2 * MIN)] } } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: 'reset_limit' })
    expect(sends(t)).toBe(0)
  })

  it('an old unknown or stale sent row never blocks: it holds only its own key, and ages out of the window', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [
      pwRow(null, 'unknown', 2 * 24 * 60 * MIN), pwRow(1, 'unknown', 45 * MIN), pwRow(2, 'sent', 40 * MIN, { finished_at: null }),
    ] } } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', sent: true })
    expect(sends(t)).toBe(1)
    expect(ledger(t.store).at(-1)).toMatchObject({ idempotency_key: `pw:${LOC}:${USER}:3`, stage: 'done' })
  })

  it('the live case: the one legacy done reset (pw:<loc>:<user>, no suffix) no longer blocks the next', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [pwRow(null, 'done', 60 * MIN)] } } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', sent: true })
    expect(sends(t)).toBe(1)
    expect(ledger(t.store).at(-1).idempotency_key).toBe(`pw:${LOC}:${USER}:1`)
  })

  it('refused attempts (nothing sent) and other people, studios or ops never count', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [
      pwRow(1, 'refused', 5 * MIN), pwRow(2, 'refused', 4 * MIN), pwRow(3, 'refused', 3 * MIN),
      pwRow(9, 'done', 2 * MIN, { id: 'other-user', un1t_user_id: 'usr-other', idempotency_key: `pw:${LOC}:usr-other:9` }),
      pwRow(8, 'done', 2 * MIN, { id: 'other-loc', location_id: 'loc-other', idempotency_key: `pw:loc-other:${USER}:8` }),
      pwRow(7, 'done', 2 * MIN, { id: 'other-op', op: 'book', idempotency_key: `book:${LOC}:${USER}:ev` }),
    ] } } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', sent: true })
    expect(sends(t)).toBe(1)
    expect(ledger(t.store).at(-1).idempotency_key).toBe(`pw:${LOC}:${USER}:4`)
  })

  it('a double-click (two concurrent calls) sends one email: both take the same next key and the open-row index refuses the second', async () => {
    const t = await setup({ routes: okRoute() })
    const [a, b] = await Promise.all([forgotPassword(t.db, pwArgs(), t.deps), forgotPassword(t.db, pwArgs(), t.deps)])
    expect(sends(t)).toBe(1)
    expect([a.verdict, b.verdict].filter((v) => v === 'done').length).toBeGreaterThanOrEqual(1)
    expect([a, b].filter((r) => r.sent)).toHaveLength(1)
    expect(new Set(ledger(t.store).map((r) => r.idempotency_key))).toEqual(new Set([`pw:${LOC}:${USER}:1`]))
  })

  it('a reset still in flight for this person (a sent row under 3 minutes old) refuses a new one with nothing sent', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [pwRow(1, 'sent', 10_000, { finished_at: null })] } } })
    const r = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', sent: false, code: C.ATTEMPT_IN_FLIGHT, retryable: true, ledgerId: 'led-pw-1-sent' })
    expect(sends(t)).toBe(0)
    expect(ledger(t.store)).toHaveLength(1)
  })

  it('a second call that read the ledger before the first began and inserted after it finished still sends nothing (the post-insert done check)', async () => {
    const t = await setup({ routes: okRoute() })
    const first = await forgotPassword(t.db, pwArgs(), t.deps)
    expect(first).toMatchObject({ verdict: 'done', sent: true })
    // The second call's allowance read is served from before the first call's insert.
    const stale = staleFirstRead(t)
    const second = await forgotPassword(stale, pwArgs(), t.deps)
    expect(sends(t)).toBe(1)
    expect(second).toMatchObject({ verdict: 'done', sent: false, ledgerId: first.ledgerId })
    const rows = ledger(t.store)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ idempotency_key: `pw:${LOC}:${USER}:1`, stage: 'refused', code: 'duplicate_attempt' })
  })

  it('review fix (minor): a stalled caller whose old number is free still counts the window again after its insert, and never sends a 4th', async () => {
    const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [
      pwRow(1, 'refused', 6 * MIN), pwRow(2, 'done', 5 * MIN), pwRow(3, 'done', 4 * MIN), pwRow(4, 'done', 3 * MIN),
    ] } } })
    // It read the ledger before any of these existed, so it takes n = 1, whose
    // only row is refused (the key is free): the post-insert recount stops it.
    const r = await forgotPassword(staleFirstRead(t), pwArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', sent: false, code: 'reset_limit' })
    expect(r.data.nextAllowedAt).toEqual(expect.any(String))
    expect(sends(t)).toBe(0)
    expect(ledger(t.store).at(-1)).toMatchObject({ idempotency_key: `pw:${LOC}:${USER}:1`, stage: 'refused', code: 'reset_limit' })
  })

  describe('firstOnly (the funnel set-password step: one reset per account)', () => {
    it('sends the first reset, under attempt 1', async () => {
      const t = await setup({ routes: okRoute() })
      const r = await forgotPassword(t.db, pwArgs({ firstOnly: true }), t.deps)
      expect(r).toMatchObject({ verdict: 'done', sent: true })
      expect(ledger(t.store)[0].idempotency_key).toBe(`pw:${LOC}:${USER}:1`)
    })

    it('a done, sent or unknown reset for this person (any key) skips: nothing sent, code reset_already_requested, its stage in data', async () => {
      for (const [row, stage] of [[pwRow(null, 'done', 3 * 24 * 60 * MIN), 'done'], [pwRow(2, 'unknown', 2 * 60 * MIN), 'unknown'], [pwRow(1, 'sent', 10_000, { finished_at: null }), 'sent']]) {
        const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [row] } } })
        const r = await forgotPassword(t.db, pwArgs({ firstOnly: true }), t.deps)
        expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS)
        expect(r).toMatchObject({ verdict: 'refused', sent: false, code: 'reset_already_requested', retryable: false, ledgerId: row.id, data: { priorStage: stage } })
        expect(sends(t)).toBe(0)
        expect(ledger(t.store)).toHaveLength(1)
      }
    })

    it('a refused earlier reset (nothing sent) does not skip', async () => {
      const t = await setup({ routes: okRoute(), db: { tables: { un1t_write_events: [pwRow(1, 'refused', 5 * MIN)] } } })
      const r = await forgotPassword(t.db, pwArgs({ firstOnly: true }), t.deps)
      expect(r).toMatchObject({ verdict: 'done', sent: true })
      expect(ledger(t.store).at(-1).idempotency_key).toBe(`pw:${LOC}:${USER}:2`)
    })

    it('the reviewed race: B read "no resets", A finished done before B got here; B sends nothing and its beforeSend never runs', async () => {
      const t = await setup({ routes: okRoute() })
      const aHook = vi.fn(async () => {})
      const a = await forgotPassword(t.db, pwArgs({ firstOnly: true, beforeSend: aHook }), t.deps)
      expect(a).toMatchObject({ verdict: 'done', sent: true })
      const bHook = vi.fn(async () => {})
      // B checked earlier (the account step's own read) but forgotPassword reads now: it sees A's done.
      const b = await forgotPassword(t.db, pwArgs({ firstOnly: true, beforeSend: bHook }), t.deps)
      expect(b).toMatchObject({ verdict: 'refused', code: 'reset_already_requested', data: { priorStage: 'done' } })
      // Even when B's own read is stale too, the post-insert check stops it before the hook.
      const c = await forgotPassword(staleFirstRead(t), pwArgs({ firstOnly: true, beforeSend: bHook }), t.deps)
      expect(c).toMatchObject({ verdict: 'done', sent: false, ledgerId: a.ledgerId })
      expect(sends(t)).toBe(1)
      expect(aHook).toHaveBeenCalledTimes(1)
      expect(bHook).not.toHaveBeenCalled()
    })

    it('two concurrent firstOnly calls take attempt 1 together: one send, one beforeSend', async () => {
      const t = await setup({ routes: okRoute() })
      const hook = vi.fn(async () => {})
      await Promise.all([
        forgotPassword(t.db, pwArgs({ firstOnly: true, beforeSend: hook }), t.deps),
        forgotPassword(t.db, pwArgs({ firstOnly: true, beforeSend: hook }), t.deps),
      ])
      expect(sends(t)).toBe(1)
      expect(hook).toHaveBeenCalledTimes(1)
      expect(new Set(ledger(t.store).map((r) => r.idempotency_key))).toEqual(new Set([`pw:${LOC}:${USER}:1`]))
    })

    it('beforeSend runs after the attempt is claimed and before the request; its failure never blocks the reset', async () => {
      const t = await setup({ routes: okRoute() })
      const order = []
      const hook = vi.fn(async () => { order.push(['hook', ledger(t.store).map((r) => r.stage), t.fetchImpl.writes().length]); throw new Error('postmark down') })
      const r = await forgotPassword(t.db, pwArgs({ firstOnly: true, beforeSend: hook }), t.deps)
      expect(order).toEqual([['hook', ['sent'], 0]])
      expect(r).toMatchObject({ verdict: 'done', sent: true })
      expect(sends(t)).toBe(1)
    })
  })

  it('the allowance read failing throws before anything is sent (a retry is safe)', async () => {
    const t = await setup({ routes: okRoute(), db: { fail: { 'un1t_write_events.select': { code: 'XX000' } } } })
    await expect(forgotPassword(t.db, pwArgs(), t.deps)).rejects.toThrow(/un1t_write_events/)
    expect(sends(t)).toBe(0)
  })
})

describe('createCheckoutLink', () => {
  const URL_OUT = 'https://checkout.example.test/session/cs_test_abc123'
  const checkoutRoutes = (over = {}) => ({ 'POST /purchases/checkout': [created({ checkoutUrl: URL_OUT, free: false })], ...over })

  // MIAFIX.1 (5) — and the ledger row's id, so the purchase intent can name
  // its un1t_write_events row (un1t_write_id stayed null live).
  it('createCheckoutLink: signature and return { checkoutUrl, free, ledgerId }', async () => {
    const t = await setup({ routes: checkoutRoutes(), db: { tables: checkoutTables() } })
    const out = await createCheckoutLink(t.db, checkoutArgs(), t.deps)
    expect(out).toEqual({ checkoutUrl: URL_OUT, free: false, ledgerId: ledger(t.store)[0].id })
    expect(out.ledgerId).toBeTruthy()
    expect(t.fetchImpl.writes()[0].body).toEqual({
      productId: PRODUCT, successUrl: checkoutArgs().successUrl, cancelUrl: checkoutArgs().cancelUrl, userId: USER,
    })
    expect(ledger(t.store)[0]).toMatchObject({ op: 'checkout', origin: 'mia', target: PRODUCT, un1t_user_id: USER })
  })

  it('free: true is returned as is', async () => {
    const t = await setup({ routes: checkoutRoutes({ 'POST /purchases/checkout': [created({ checkoutUrl: URL_OUT, free: true })] }), db: { tables: checkoutTables() } })
    await expect(createCheckoutLink(t.db, checkoutArgs(), t.deps)).resolves.toEqual({ checkoutUrl: URL_OUT, free: true, ledgerId: expect.any(String) })
  })

  it('createCheckoutLink refuses a €0 product (free_product_not_via_checkout), a product not active at the studio, and a userId with no un1t_clients row here', async () => {
    const cases = [
      [checkoutTables({ price_cents: 0 }), 'free_product_not_via_checkout'],
      [checkoutTables({ status: 'archived' }), 'product_not_sellable'],
      [{ ...checkoutTables(), un1t_products: [] }, 'product_not_sellable'],
      [{ ...checkoutTables(), un1t_products: [{ id: 'pr-1', location_id: 'loc-elsewhere', un1t_id: PRODUCT, status: 'active', price_cents: 2000 }] }, 'product_not_sellable'],
      [{ ...checkoutTables(), un1t_clients: [{ id: 'cl-9', location_id: 'loc-elsewhere', un1t_user_id: USER }] }, 'no_client_at_studio'],
    ]
    for (const [tables, code] of cases) {
      const t = await setup({ routes: checkoutRoutes(), db: { tables } })
      const err = await createCheckoutLink(t.db, checkoutArgs(), t.deps).catch((e) => e)
      expect(err).toBeInstanceOf(Un1tWriteRefused)
      expect(err.code).toBe(code)
      expect(t.fetchImpl.writes()).toHaveLength(0)
      expect(ledger(t.store)).toHaveLength(0)
    }
  })

  it("createCheckoutLink refuses non-https and foreign-host URLs (the host must be this studio's customer host)", async () => {
    const bad = [
      { successUrl: 'http://hatch.example.test/pay-done/tok-1' },
      { cancelUrl: 'https://evil.example.test/pay-done/tok-1' },
      { successUrl: 'https://hatch.example.test.evil.test/x' },
      { successUrl: 'https://user:pw@hatch.example.test/x' },
      { cancelUrl: 'not a url' },
      { successUrl: undefined },
    ]
    for (const over of bad) {
      const t = await setup({ routes: checkoutRoutes(), db: { tables: checkoutTables() } })
      const err = await createCheckoutLink(t.db, checkoutArgs(over), t.deps).catch((e) => e)
      expect(err).toBeInstanceOf(Un1tWriteRefused)
      expect(err.code).toBe('not_a_customer_url')
      expect(t.fetchImpl.writes()).toHaveLength(0)
    }
  })

  it('createCheckoutLink sends the key as idempotency-key, stores it and the URL on the ledger, never logs the URL', async () => {
    const t = await setup({ routes: checkoutRoutes({ 'POST /purchases/checkout': [created({ checkoutUrl: URL_OUT, free: true })] }), db: { tables: checkoutTables() } })
    await createCheckoutLink(t.db, checkoutArgs(), t.deps)
    expect(t.fetchImpl.writes()[0].headers['idempotency-key']).toBe('intent-1')
    expect(ledger(t.store)[0]).toMatchObject({ idempotency_key: 'intent-1', checkout_url: URL_OUT, stage: 'done' })
    expect(ledger(t.store)[0].un1t_ref ?? null).toBeNull()
    expect(JSON.stringify([allLogs(), recordErrorEvent.mock.calls])).not.toContain('cs_test_abc123')
  })

  it('createCheckoutLink 5xx retries once with the same key; twice is Un1tWriteUnknown', async () => {
    const a = await setup({ routes: checkoutRoutes({ 'POST /purchases/checkout': [res(503, {}), created({ checkoutUrl: URL_OUT, free: false })] }), db: { tables: checkoutTables() } })
    const retried = await createCheckoutLink(a.db, checkoutArgs(), a.deps)
    expect(retried).toEqual({ checkoutUrl: URL_OUT, free: false, ledgerId: ledger(a.store)[0].id })
    const keys = a.fetchImpl.writes().map((w) => w.headers['idempotency-key'])
    expect(keys).toEqual(['intent-1', 'intent-1'])

    const b = await setup({ routes: checkoutRoutes({ 'POST /purchases/checkout': [res(503, {})] }), db: { tables: checkoutTables() } })
    const err = await createCheckoutLink(b.db, checkoutArgs(), b.deps).catch((e) => e)
    expect(err).toBeInstanceOf(Un1tWriteUnknown)
    expect(b.fetchImpl.writes()).toHaveLength(2)
    expect(ledger(b.store)[0].stage).toBe('unknown')
  })

  it('a refusal rejects Un1tWriteRefused with un1t.online code; a switch refusal rejects with the UN1T_ code', async () => {
    const a = await setup({ routes: checkoutRoutes({ 'POST /purchases/checkout': [res(400, { success: false, error: { code: 'PRODUCT_UNAVAILABLE', message: 'Not for sale' } })] }), db: { tables: checkoutTables() } })
    const e1 = await createCheckoutLink(a.db, checkoutArgs(), a.deps).catch((e) => e)
    expect(e1).toBeInstanceOf(Un1tWriteRefused)
    expect(e1).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', message: 'Not for sale' })
    expect(ledger(a.store)[0].stage).toBe('refused')

    const b = await setup({ db: { settings: {}, tables: checkoutTables() } })
    const e2 = await createCheckoutLink(b.db, checkoutArgs(), b.deps).catch((e) => e)
    expect(e2).toBeInstanceOf(Un1tWriteRefused)
    expect(e2.code).toBe(C.WRITES_OFF)
    expect(b.fetchImpl).not.toHaveBeenCalled()
  })

  it('a customer host that cannot be read rejects Un1tSettingsReadError, not a refusal (minor 3)', async () => {
    const { resolveCustomerBaseUrl } = await import('./tenant-host.js')
    resolveCustomerBaseUrl.mockRejectedValueOnce(new Error('APP_URL is not set'))
    const t = await setup({ routes: checkoutRoutes(), db: { tables: checkoutTables() } })
    const err = await createCheckoutLink(t.db, checkoutArgs(), t.deps).catch((e) => e)
    expect(err).toBeInstanceOf(Un1tSettingsReadError)
    expect(err.code).toBe('customer_url_unreadable')
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it('createCheckoutLink never calls /purchases/charge', async () => {
    const t = await setup({ routes: checkoutRoutes({ 'POST /purchases/checkout': [res(503, {}), res(503, {})] }), db: { tables: checkoutTables() } })
    await createCheckoutLink(t.db, checkoutArgs(), t.deps).catch(() => {})
    expect(t.fetchImpl.calls.some((c) => c.url.includes('/purchases/charge'))).toBe(false)
    expect(createCheckoutLink.toString()).not.toContain('/purchases/charge')
  })
})

describe('the mirror never changes the verdict', () => {
  it('a mirror write failure leaves the verdict done and logs ids only', async () => {
    const t = await setup({
      routes: { 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [credits()] },
      db: { fail: { 'un1t_bookings.upsert': { code: 'XX000', message: `boom for ${EMAIL}`, details: 'Key (x)=(secret)' } } },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING })
    expect(ledger(t.store)[0].stage).toBe('done')
    const errs = logError.mock.calls.filter(([mod]) => mod === 'un1t-online-write')
    expect(errs.length).toBeGreaterThan(0)
    for (const [, , meta] of errs) {
      for (const k of Object.keys(meta)) expect(ALLOWED_LOG_FIELDS.has(k)).toBe(true)
      expect(JSON.stringify(meta)).not.toContain(EMAIL)
      expect(JSON.stringify(meta)).not.toContain('secret')
    }
  })

  it('a mirror that throws is caught: the verdict stays done, ids-only log', async () => {
    const t = await setup({ routes: { 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [credits()] } })
    const from = t.db.from
    t.db.from = (name) => {
      if (name === 'un1t_bookings') throw new Error(`client exploded for ${EMAIL}`)
      return from(name)
    }
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING })
    expect(JSON.stringify(logError.mock.calls)).not.toContain(EMAIL)
    expect(logError).toHaveBeenCalled()
  })

  it('UN1TWRITE.11: a class_bookings failure is logged and the verdict stays done', async () => {
    const t = await setup({
      routes: { 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [credits()] },
      db: {
        tables: { un1t_events: [{ id: 'ue-1', location_id: LOC, un1t_id: EVENT, title: 'HYROX', starts_at: '2026-10-20T17:30:00.000Z' }] },
        fail: { 'class_bookings.upsert': { code: '23514', message: `boom for ${EMAIL}` } },
      },
    })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'done', id: BOOKING })
    expect(ledger(t.store)[0].stage).toBe('done')
    expect(t.store.un1t_bookings).toHaveLength(1)
    const errs = logError.mock.calls.filter(([mod, msg]) => mod === 'un1t-online-write' && /class_bookings/.test(msg))
    expect(errs).toHaveLength(1)
    expect(JSON.stringify(errs)).not.toContain(EMAIL)
  })

  it('a credits read that fails leaves the booking row and the verdict done', async () => {
    const t = await setup({ routes: { 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [res(200, 'not json')] } })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r.verdict).toBe('done')
    expect(t.store.un1t_bookings).toHaveLength(1)
  })
})

describe('carried requirements', () => {
  it('call order: ensureOp → assertAllowed → openAttempt → send → finishAttempt (nothing reaches the ledger that the transport would refuse)', async () => {
    const t = await setup({ routes: { 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [credits()] } })
    const order = []
    t.deps.writerFactory = async (d, loc) => {
      const w = await createUn1tWriter(d, loc, { fetchImpl: t.fetchImpl, sleep: t.sleep })
      const wrap = (name) => async (...a) => { order.push(name); return w[name](...a) }
      return { ...w, ensureOp: wrap('ensureOp'), openAttempt: wrap('openAttempt'), send: wrap('send'), assertAllowed: (...a) => { order.push('assertAllowed'); return w.assertAllowed(...a) } }
    }
    await book(t.db, bookArgs(), t.deps)
    expect(order).toEqual(['ensureOp', 'assertAllowed', 'openAttempt', 'send'])
    const ledgerOps = t.calls.filter((c) => c.table === 'un1t_write_events' && c.op !== 'select').map((c) => c.op)
    expect(ledgerOps).toEqual(['insert', 'update'])
  })

  it('a refusal before the ledger (writes off, missing permission) leaves no ledger row', async () => {
    const a = await setup({ db: { settings: { un1t_online: { writes_enabled: false } } } })
    expect(await book(a.db, bookArgs(), a.deps)).toMatchObject({ verdict: 'refused', code: C.WRITES_OFF, ledgerId: null })
    expect(ledger(a.store)).toHaveLength(0)
    const b = await setup({ routes: { 'GET /api-token': [selfRes(['bookings:read'])] } })
    expect(await book(b.db, bookArgs(), b.deps)).toMatchObject({ verdict: 'refused', code: C.PERMISSION_MISSING })
    expect(ledger(b.store)).toHaveLength(0)
  })

  it('a refusal with sent:false finishes the ledger row refused (budget, throttle, token), freeing the key', async () => {
    // Slot 1 is the permission read; slot 2 the write.
    const a = await setup({ routes: { 'POST /bookings': [created(bookingDto())] }, db: { rate: (n) => (n >= 2 ? 31 : 1) } })
    expect(await book(a.db, bookArgs(), a.deps)).toMatchObject({ verdict: 'refused', code: C.RATE_BUDGET, sent: false, retryable: true })
    expect(ledger(a.store)[0]).toMatchObject({ stage: 'refused', code: C.RATE_BUDGET })
    expect(a.fetchImpl.writes()).toHaveLength(0)

    const b = await setup({ routes: { 'POST /bookings': [res(429, {}, { 'retry-after': '1' })] } })
    expect(await book(b.db, bookArgs(), b.deps)).toMatchObject({ verdict: 'refused', code: C.RATE_LIMITED, sent: false })
    expect(ledger(b.store)[0]).toMatchObject({ stage: 'refused', code: C.RATE_LIMITED })

    const c = await setup({ routes: { 'POST /bookings': [res(401, {})] } })
    expect(await book(c.db, bookArgs(), c.deps)).toMatchObject({ verdict: 'refused', code: C.AUTH, sent: false })
    expect(ledger(c.store)[0]).toMatchObject({ stage: 'refused', code: C.AUTH })
  })

  it('UN1T_RATE_BUDGET or UN1T_RATE_LIMITED after something went out (sent:true) finishes the ledger unknown, so the retry checks first', async () => {
    // 1 permission read, 2 the write (503), 3 the check read (absent), 4+ the re-send: spent.
    const a = await setup({
      routes: { 'POST /bookings': [res(503, {})], [USER_BOOKINGS]: [page([])] },
      db: { rate: (n) => (n >= 4 ? 31 : 1) },
    })
    const r1 = await book(a.db, bookArgs(), a.deps)
    expect(r1).toMatchObject({ verdict: 'refused', code: C.RATE_BUDGET, sent: true, retryable: true })
    expect(ledger(a.store)[0]).toMatchObject({ stage: 'unknown', code: C.RATE_BUDGET })

    const b = await setup({ routes: { 'POST /bookings': [res(503, {}), res(429, {}, { 'retry-after': '1' })], [USER_BOOKINGS]: [page([])] } })
    const r2 = await book(b.db, bookArgs(), b.deps)
    expect(r2).toMatchObject({ verdict: 'refused', code: C.RATE_LIMITED, sent: true })
    expect(ledger(b.store)[0]).toMatchObject({ stage: 'unknown', code: C.RATE_LIMITED })

    // The retry finds the row in doubt and runs the check read before any send.
    const mark = b.fetchImpl.calls.length
    await book(b.db, bookArgs(), b.deps)
    const after = b.fetchImpl.calls.slice(mark).map((c) => c.key)
    expect(ledger(b.store)[0]).toMatchObject({ stage: 'refused', code: 'not_landed' })
    expect(after.indexOf(USER_BOOKINGS)).toBeGreaterThanOrEqual(0)
    expect(after.indexOf(USER_BOOKINGS)).toBeLessThan(after.indexOf('POST /bookings'))
  })

  it('open_row_gone (the open row finished while it was read) is a retry: UN1T_ATTEMPT_IN_FLIGHT, retryable, nothing sent', async () => {
    const key = `book:${LOC}:${USER}:${EVENT}`
    const t = await setup({ db: { hideOpenRows: true, tables: { un1t_write_events: [{ id: 'led-x', location_id: LOC, idempotency_key: key, op: 'book', stage: 'sent', created_at: ago(30_000) }] } } })
    const r = await book(t.db, bookArgs(), t.deps)
    expect(r).toMatchObject({ verdict: 'refused', code: C.ATTEMPT_IN_FLIGHT, retryable: true, sent: false })
    expect(t.fetchImpl.writes()).toHaveLength(0)
    expect(logError).not.toHaveBeenCalled()
  })

  it('findDone for book accounts for a later cancel', async () => {
    const bookKey = `book:${LOC}:${USER}:${EVENT}`
    const doneBook = { id: 'led-b', location_id: LOC, idempotency_key: bookKey, op: 'book', stage: 'done', un1t_ref: BOOKING, created_at: ago(60 * 60_000) }
    const laterCancel = { id: 'led-c', location_id: LOC, idempotency_key: `cancel:${LOC}:${BOOKING}`, op: 'cancel', stage: 'done', un1t_ref: BOOKING, created_at: ago(30 * 60_000) }

    const live = makeDb({ tables: { un1t_write_events: [doneBook] } })
    await expect(findDoneBooking(live.db, { locationId: LOC, un1tUserId: USER, eventId: EVENT })).resolves.toMatchObject({ id: 'led-b' })
    const undone = makeDb({ tables: { un1t_write_events: [doneBook, laterCancel] } })
    await expect(findDoneBooking(undone.db, { locationId: LOC, un1tUserId: USER, eventId: EVENT })).resolves.toBeNull()

    // A live done book is confirmed by the check read before anything is sent again.
    const a = await setup({ routes: { [USER_BOOKINGS]: [page([bookingDto({ created_at: LONG_AGO })])], [CREDITS_PATH]: [credits()] }, db: { tables: { un1t_write_events: [doneBook] } } })
    const r1 = await book(a.db, bookArgs(), a.deps)
    expect(r1).toMatchObject({ verdict: 'done', alreadyBooked: true, id: BOOKING, sent: false, ledgerId: 'led-b' })
    expect(a.fetchImpl.writes()).toHaveLength(0)

    // A done book that a later cancel undid books again.
    const b = await setup({ routes: { 'POST /bookings': [created(bookingDto({ id: 'booking-2' }))], [CREDITS_PATH]: [credits()] }, db: { tables: { un1t_write_events: [doneBook, laterCancel] } } })
    const r2 = await book(b.db, bookArgs(), b.deps)
    expect(r2).toMatchObject({ verdict: 'done', id: 'booking-2', sent: true })
    expect(b.fetchImpl.count(USER_BOOKINGS)).toBe(0)

    // A live ledger booking the member cancelled in the app: the check read says absent, so it is sent.
    const c = await setup({ routes: { [USER_BOOKINGS]: [page([bookingDto({ status: 'cancelled' })])], 'POST /bookings': [created(bookingDto({ id: 'booking-3' }))], [CREDITS_PATH]: [credits()] }, db: { tables: { un1t_write_events: [doneBook] } } })
    expect(await book(c.db, bookArgs(), c.deps)).toMatchObject({ verdict: 'done', id: 'booking-3' })
  })

  it('a live done ledger book whose check read is unknown sends nothing: unknown, tied to the prior row (fix 1)', async () => {
    const bookKey = `book:${LOC}:${USER}:${EVENT}`
    const doneBook = { id: 'led-b', location_id: LOC, idempotency_key: bookKey, op: 'book', stage: 'done', un1t_ref: BOOKING, created_at: ago(60 * 60_000) }
    for (const routes of [{ [USER_BOOKINGS]: [res(500, {})] }, { [USER_BOOKINGS]: [page([bookingDto({ status: 'waitlisted', created_at: LONG_AGO })])] }]) {
      const t = await setup({ routes: { 'POST /bookings': [created(bookingDto())], ...routes }, db: { tables: { un1t_write_events: [doneBook] } } })
      const r = await book(t.db, bookArgs(), t.deps)
      expect(C.ALREADY_BOOKED_UNVERIFIED).toBe('already_booked_unverified')
      expect(r).toMatchObject({ verdict: 'unknown', code: C.ALREADY_BOOKED_UNVERIFIED, sent: false, ledgerId: 'led-b', alreadyBooked: false })
      expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS)
      expect(t.fetchImpl.writes()).toHaveLength(0)
      expect(ledger(t.store)).toHaveLength(1)
    }
  })

  it('the done-trial check spans both methods (one trial per person and product)', async () => {
    const row = (method, stage = 'done') => ({
      id: `led-${method}`, location_id: LOC, op: 'trial', method, stage, un1t_user_id: USER, target: PRODUCT,
      idempotency_key: `trial:${LOC}:${USER}:${PRODUCT}:${method}`, created_at: ago(60_000),
    })
    for (const method of ['charge', 'free_checkout']) {
      const { db } = makeDb({ tables: { un1t_write_events: [row(method)] } })
      await expect(findDoneTrial(db, { locationId: LOC, un1tUserId: USER, productId: PRODUCT })).resolves.toMatchObject({ method })
    }
    const none = makeDb({ tables: { un1t_write_events: [row('charge', 'unknown'), { ...row('free_checkout'), un1t_user_id: 'someone-else' }] } })
    await expect(findDoneTrial(none.db, { locationId: LOC, un1tUserId: USER, productId: PRODUCT })).resolves.toBeNull()
    const broken = makeDb({ fail: { 'un1t_write_events.select': { code: 'XX000' } } })
    await expect(findDoneTrial(broken.db, { locationId: LOC, un1tUserId: USER, productId: PRODUCT })).rejects.toThrow()
  })

  it('trial ledger rows carry un1t_user_id and target from the first write (the sent row)', async () => {
    const t = await setup()
    const writer = await t.deps.writerFactory(t.db, LOC)
    const base = { op: 'trial', origin: 'funnel', method: 'charge', key: `trial:${LOC}:${USER}:${PRODUCT}:charge` }
    await expect(writer.openAttempt({ ...base, target: PRODUCT }, {})).rejects.toBeInstanceOf(TypeError)
    await expect(writer.openAttempt({ ...base, un1tUserId: USER }, {})).rejects.toBeInstanceOf(TypeError)
    expect(ledger(t.store)).toHaveLength(0)
    const out = await writer.openAttempt({ ...base, un1tUserId: USER, target: PRODUCT }, {})
    expect(out.row).toMatchObject({ stage: 'sent', un1t_user_id: USER, target: PRODUCT, method: 'charge' })
  })

  it('dedupe and lookup paths log ids only: no email, name, phone or token in any log line or request URL', async () => {
    const t = await setup({
      routes: {
        'POST /bookings': [res(503, {})], [USER_BOOKINGS]: [res(500, {})],
        'POST /users/clients': [res(503, {})], 'GET /users/clients': [res(502, {})],
      },
      db: { tables: { contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null }] } },
    })
    await book(t.db, bookArgs(), t.deps)
    await createClient(t.db, createArgs(), t.deps)
    const logs = JSON.stringify(allLogs())
    for (const needle of [EMAIL, PHONE, 'Test Person', TOKEN]) expect(logs).not.toContain(needle)
    for (const [mod, , meta] of writeLogs()) {
      expect(mod).toBe('un1t-online-write')
      for (const k of Object.keys(meta ?? {})) expect(ALLOWED_LOG_FIELDS.has(k)).toBe(true)
    }
    // The read client logs its path: ids and paging only.
    for (const [mod, , meta] of allLogs().filter(([m]) => m === 'un1t-online')) {
      expect(mod).toBe('un1t-online')
      if (meta?.path) expect(meta.path).toMatch(/^\/(users\/[0-9a-f-]+\/bookings|users\/clients|api-token)(\?page=\d+&pageSize=\d+)?$/)
    }
  })
})

describe('throw contract', () => {
  it('rejects with Un1tSettingsReadError when the switch cannot be read, before anything is sent', async () => {
    const t = await setup({ db: { locationError: { code: 'XX000' } } })
    await expect(book(t.db, bookArgs(), t.deps)).rejects.toBeInstanceOf(Un1tSettingsReadError)
    expect(t.fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects with the ledger error when the write-ahead insert fails, before anything is sent', async () => {
    const t = await setup({ db: { fail: { 'un1t_write_events.insert': { code: '42501' } } } })
    await expect(book(t.db, bookArgs(), t.deps)).rejects.toMatchObject({ code: '42501' })
    expect(t.fetchImpl.writes()).toHaveLength(0)
  })

  it('every un1t.online outcome resolves as a result (5xx, refusal, no reply)', async () => {
    const t = await setup({ routes: { 'POST /bookings': [() => { throw new TypeError('fetch failed') }], [USER_BOOKINGS]: [res(500, {})] } })
    await expect(book(t.db, bookArgs(), t.deps)).resolves.toMatchObject({ verdict: 'unknown' })
    const u = await setup({ routes: { 'POST /bookings': [res(400, { success: false, error: { code: 'NO_CREDITS', message: 'No credits left' } })] } })
    await expect(book(u.db, bookArgs(), u.deps)).resolves.toMatchObject({ verdict: 'refused', code: 'NO_CREDITS', message: 'No credits left', retryable: false })
  })
})

describe('the dedupe reads', () => {
  const writerWith = async (routes) => {
    const t = await setup({ routes })
    return { t, writer: await t.deps.writerFactory(t.db, LOC) }
  }

  it('findLandedBooking returns the state, the id and a picked row (no embedded user)', async () => {
    const { writer } = await writerWith({ [USER_BOOKINGS]: [page([bookingDto({ user: { id: USER, email: EMAIL }, created_at: LONG_AGO })])] })
    const out = await findLandedBooking(writer, { un1tUserId: USER, eventId: EVENT, sentAt: Date.now() })
    expect(out).toMatchObject({ state: 'landed', id: BOOKING })
    expect(JSON.stringify(out)).not.toContain(EMAIL)
  })

  it('findCancelState: cancelled landed, booked absent, attended/no_show already_happened, another id or a failed read unknown', async () => {
    const states = [['cancelled', 'landed'], ['canceled', 'landed'], ['booked', 'absent'], ['attended', 'already_happened'], ['no_show', 'already_happened'], ['waitlisted', 'unknown']]
    for (const [status, want] of states) {
      const { writer } = await writerWith({ [BOOKING_PATH]: [ok(bookingDto({ status }))] })
      await expect(findCancelState(writer, { bookingId: BOOKING })).resolves.toBe(want)
    }
    const other = await writerWith({ [BOOKING_PATH]: [ok(bookingDto({ id: 'booking-other', status: 'cancelled' }))] })
    await expect(findCancelState(other.writer, { bookingId: BOOKING })).resolves.toBe('unknown')
    const failed = await writerWith({ [BOOKING_PATH]: [res(500, {})] })
    await expect(findCancelState(failed.writer, { bookingId: BOOKING })).resolves.toBe('unknown')
  })

  it('findClientByEmail walks every page and matches trimmed, lower-cased exact emails; a failed walk throws', async () => {
    const two = [
      res(200, { success: true, pagination: { total: 3, page: 1, pages: 2, pageSize: 100 }, data: [{ id: 'u-1', email: 'x@example.test' }, { id: 'u-2', email: ` ${EMAIL.toUpperCase()}` }] }),
      res(200, { success: true, pagination: { total: 3, page: 2, pages: 2, pageSize: 100 }, data: [{ id: 'u-3', email: 'person.test@example.test.evil' }] }),
    ]
    const { t, writer } = await writerWith({ 'GET /users/clients': two })
    await expect(findClientByEmail(writer, EMAIL)).resolves.toEqual({ matches: ['u-2'] })
    expect(t.fetchImpl.count('GET /users/clients')).toBe(2)
    const failed = await writerWith({ 'GET /users/clients': [res(500, {})] })
    await expect(findClientByEmail(failed.writer, EMAIL)).rejects.toThrow()
  })

  it('UN1TINCR.1: createdSince walks newest first only back to that time, and never puts the email in a URL', async () => {
    const pg = (p, data) => res(200, { success: true, pagination: { total: 250, page: p, pages: 3, pageSize: 100 }, data })
    const routes = {
      'GET /users/clients': [
        pg(1, [
          { id: 'u-new', email: EMAIL, created_at: '2026-10-28T12:00:00.000Z' },
          { id: 'u-older', email: 'x@example.test', created_at: '2026-10-01T12:00:00.000Z' },
        ]),
        pg(2, [{ id: 'u-ancient', email: EMAIL, created_at: '2026-08-01T12:00:00.000Z' }]),
      ],
    }
    const { t, writer } = await writerWith(routes)
    await expect(findClientByEmail(writer, EMAIL, { createdSince: '2026-10-20T00:00:00.000Z' })).resolves.toEqual({ matches: ['u-new'] })
    expect(t.fetchImpl.count('GET /users/clients')).toBe(1)
    for (const c of t.fetchImpl.calls) expect(decodeURIComponent(c.url)).not.toContain(EMAIL)
  })

  it('UN1TINCR.1: without createdSince the walk still reads every page', async () => {
    const pg = (p, data) => res(200, { success: true, pagination: { total: 2, page: p, pages: 2, pageSize: 100 }, data })
    const { t, writer } = await writerWith({
      'GET /users/clients': [
        pg(1, [{ id: 'u-new', email: 'x@example.test', created_at: '2026-10-28T12:00:00.000Z' }]),
        pg(2, [{ id: 'u-ancient', email: EMAIL, created_at: '2026-08-01T12:00:00.000Z' }]),
      ],
    })
    await expect(findClientByEmail(writer, EMAIL)).resolves.toEqual({ matches: ['u-ancient'] })
    expect(t.fetchImpl.count('GET /users/clients')).toBe(2)
  })
})

describe('UN1TWRITE.22 — a write that timed out', () => {
  it('is unknown and never sent again, even when the check read finds nothing', async () => {
    const timeout = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }
    const s = await setup({ routes: { 'POST /bookings': [timeout], [USER_BOOKINGS]: [page([])] } })
    const r = await book(s.db, bookArgs(), s.deps)
    expect(r.verdict).toBe('unknown')
    expect(s.fetchImpl.count('POST /bookings')).toBe(1)
    expect(s.fetchImpl.calls.find((c) => c.key === 'POST /bookings')).toBeTruthy()
  })

  it('every write carries an abort signal', async () => {
    const s = await setup({ routes: { 'POST /bookings': [created(bookingDto())], [CREDITS_PATH]: [credits()] } })
    await book(s.db, bookArgs(), s.deps)
    const call = s.fetchImpl.mock.calls.find(([url, init]) => init?.method === 'POST')
    expect(call[1].signal).toBeInstanceOf(AbortSignal)
  })
})
