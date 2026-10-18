import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { logError, logWarn, logInfo } from './log'
import { applyUn1tWriteToMirror } from './un1t-online-mirror-write.js'
import { LOC, ORG, STUDIO, EVENT, USER, BOOKING, NEW_USER, CONTACT, OTHER_CONTACT, ALLOWED_LOG_FIELDS, makeDb } from './un1t-online-write.test-helpers.js'

const NOW = '2026-10-18T10:00:00.000Z'
const REQUESTED = '2026-10-18T09:59:58.000Z'
const now = () => new Date(NOW)
const picked = (over = {}) => ({
  id: BOOKING, event_id: EVENT, user_id: USER, studio_id: STUDIO, status: 'booked',
  created_at: '2026-10-18T09:59:59.000Z', updated_at: '2026-10-18T09:59:59.000Z', has_guest: false, ...over,
})
const readFrom = (routes) => vi.fn(async (path) => {
  if (!(path in routes)) throw new Error(`test: unexpected read ${path}`)
  const v = routes[path]
  if (v instanceof Error) throw v
  return typeof v === 'function' ? v() : v
})
const CREDITS = `/credits/ledgers/${USER}/${STUDIO}`
const bookArgs = (over = {}) => ({ op: 'book', locationId: LOC, contactId: CONTACT, un1tUserId: USER, studioId: STUDIO, data: picked(), requestedAt: REQUESTED, ledgerId: 'led-1', ...over })
const client = () => ({ id: 'cl-1', location_id: LOC, un1t_user_id: USER, credit_balance: 9, credit_unlimited: false, crm_written_at: null, status: 'active' })
const tablesTouched = (calls) => [...new Set(calls.map((c) => c.table))]

beforeEach(() => vi.clearAllMocks())

describe('book', () => {
  it('upserts un1t_bookings through mapBooking with contact_id and crm_written_at = now, then refreshes credits', async () => {
    const { db, store, calls } = makeDb({ tables: { un1t_clients: [client()] } })
    const read = readFrom({ [CREDITS]: { balance: 3, is_unlimited: true } })
    const out = await applyUn1tWriteToMirror(db, bookArgs(), { read, now })
    expect(out.ok).toBe(true)
    const up = calls.find((c) => c.table === 'un1t_bookings' && c.op === 'upsert')
    expect(up.opts).toMatchObject({ onConflict: 'location_id,un1t_id' })
    expect(store.un1t_bookings[0]).toMatchObject({
      location_id: LOC, un1t_id: BOOKING, un1t_user_id: USER, event_id: EVENT, status: 'booked', contact_id: CONTACT,
      crm_written_at: NOW, synced_at: REQUESTED, remote_updated_at: '2026-10-18T09:59:59.000Z',
    })
    expect(out.row).toMatchObject({ un1t_id: BOOKING, crm_written_at: NOW })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(CREDITS)
    expect(store.un1t_clients[0]).toMatchObject({ credit_balance: 3, credit_unlimited: true, crm_written_at: NOW, status: 'active' })
  })

  it('takes has_guest from the data (the picked answer has no guest fields for mapBooking to read)', async () => {
    const { db, store } = makeDb()
    await applyUn1tWriteToMirror(db, bookArgs({ data: picked({ has_guest: true }) }), { read: readFrom({ [CREDITS]: { balance: 1 } }), now })
    expect(store.un1t_bookings[0].has_guest).toBe(true)
  })

  it('a null contact id is left out, never written as NULL over the sync’s link', async () => {
    const { db, store } = makeDb({ tables: { un1t_bookings: [{ id: 'ub-1', location_id: LOC, un1t_id: BOOKING, contact_id: OTHER_CONTACT, status: 'booked' }] } })
    await applyUn1tWriteToMirror(db, bookArgs({ contactId: null }), { read: readFrom({ [CREDITS]: { balance: 1 } }), now })
    expect(store.un1t_bookings[0].contact_id).toBe(OTHER_CONTACT)
  })

  it('a booking write failure is ok:false with an ids-only logError; credits are still refreshed', async () => {
    const { db, store } = makeDb({ tables: { un1t_clients: [client()] }, fail: { 'un1t_bookings.upsert': { code: 'XX000', message: 'person.test@example.test', details: 'Key (un1t_id)=(x)' } } })
    const out = await applyUn1tWriteToMirror(db, bookArgs(), { read: readFrom({ [CREDITS]: { balance: 2 } }), now })
    expect(out.ok).toBe(false)
    expect(store.un1t_clients[0].credit_balance).toBe(2)
    const [[mod, , meta]] = logError.mock.calls
    expect(mod).toBe('un1t-online-write')
    expect(meta).toMatchObject({ locationId: LOC, op: 'book', ledgerId: 'led-1', code: 'XX000' })
    for (const k of Object.keys(meta)) expect(ALLOWED_LOG_FIELDS.has(k)).toBe(true)
    expect(JSON.stringify(logError.mock.calls)).not.toContain('example.test')
  })

  it('a failed or unreadable credits read is ok:false and logs ids only; the booking row stands', async () => {
    for (const answer of [new Error('un1t.online answered HTTP 500'), { nothing: true }]) {
      vi.clearAllMocks()
      const { db, store } = makeDb({ tables: { un1t_clients: [client()] } })
      const out = await applyUn1tWriteToMirror(db, bookArgs(), { read: readFrom({ [CREDITS]: answer }), now })
      expect(out.ok).toBe(false)
      expect(store.un1t_bookings).toHaveLength(1)
      expect(store.un1t_clients[0]).toMatchObject({ credit_balance: 9, crm_written_at: null })
      expect(logError).toHaveBeenCalled()
    }
  })

  it('a client row the sync has not brought yet is not created by the credits refresh', async () => {
    const { db, store } = makeDb()
    const out = await applyUn1tWriteToMirror(db, bookArgs(), { read: readFrom({ [CREDITS]: { balance: 2 } }), now })
    expect(out.ok).toBe(true)
    expect(store.un1t_clients).toHaveLength(0)
  })

  it('no data with an id and a status writes no booking row (never NULLs over the sync)', async () => {
    const { db, store } = makeDb()
    const out = await applyUn1tWriteToMirror(db, bookArgs({ data: { id: BOOKING } }), { read: readFrom({ [CREDITS]: { balance: 2 } }), now })
    expect(out.ok).toBe(false)
    expect(store.un1t_bookings).toHaveLength(0)
  })
})

describe('cancel', () => {
  it('re-reads GET /bookings/{id} first and writes that row', async () => {
    const { db, store } = makeDb()
    const read = readFrom({
      // A raw DTO: no flag of its own, so the guest field decides.
      [`/bookings/${BOOKING}`]: { ...picked({ status: 'cancelled', updated_at: '2026-10-18T10:00:01.000Z', has_guest: undefined }), guest_name: 'G', user: { id: USER, email: 'x@example.test' } },
      [CREDITS]: { balance: 5 },
    })
    const out = await applyUn1tWriteToMirror(db, bookArgs({ op: 'cancel', data: { id: BOOKING } }), { read, now })
    expect(out.ok).toBe(true)
    expect(read.mock.calls.map(([p]) => p)).toEqual([`/bookings/${BOOKING}`, CREDITS])
    expect(store.un1t_bookings[0]).toMatchObject({ un1t_id: BOOKING, status: 'cancelled', has_guest: true, crm_written_at: NOW, contact_id: CONTACT })
    expect(JSON.stringify(store.un1t_bookings[0])).not.toContain('x@example.test')
  })

  it('a failed re-read falls back to the answer only when it names a status; otherwise ok:false and nothing written', async () => {
    const a = makeDb()
    const out1 = await applyUn1tWriteToMirror(a.db, bookArgs({ op: 'cancel', data: picked({ status: 'cancelled' }) }), {
      read: readFrom({ [`/bookings/${BOOKING}`]: new Error('500'), [CREDITS]: { balance: 5 } }), now,
    })
    expect(out1.ok).toBe(false)
    expect(a.store.un1t_bookings[0]).toMatchObject({ status: 'cancelled' })

    const b = makeDb()
    const out2 = await applyUn1tWriteToMirror(b.db, bookArgs({ op: 'cancel', data: { id: BOOKING } }), {
      read: readFrom({ [`/bookings/${BOOKING}`]: new Error('500'), [CREDITS]: { balance: 5 } }), now,
    })
    expect(out2.ok).toBe(false)
    expect(b.store.un1t_bookings).toHaveLength(0)
  })

  it('a re-read that describes another booking is not written', async () => {
    const { db, store } = makeDb()
    const out = await applyUn1tWriteToMirror(db, bookArgs({ op: 'cancel', data: { id: BOOKING } }), {
      read: readFrom({ [`/bookings/${BOOKING}`]: picked({ id: 'booking-other', status: 'cancelled' }), [CREDITS]: { balance: 5 } }), now,
    })
    expect(out.ok).toBe(false)
    expect(store.un1t_bookings).toHaveLength(0)
  })
})

describe('create_client', () => {
  const createArgs = (over = {}) => ({ op: 'create_client', locationId: LOC, contactId: CONTACT, un1tUserId: NEW_USER, studioId: STUDIO, data: null, requestedAt: REQUESTED, ledgerId: 'led-c', ...over })

  it('links contacts.un1t_user_id only where null and inserts un1t_clients through mapClient with crm_written_at', async () => {
    const { db, store, calls } = makeDb({ tables: { contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null, email: 'keep@example.test' }] } })
    const out = await applyUn1tWriteToMirror(db, createArgs(), { read: vi.fn(), now })
    expect(out).toEqual({ ok: true })
    const upd = calls.find((c) => c.table === 'contacts' && c.op === 'update')
    expect(upd.payload).toEqual({ un1t_user_id: NEW_USER })
    expect(upd.filters).toEqual(expect.arrayContaining([['eq', 'id', CONTACT], ['is', 'un1t_user_id', null]]))
    expect(store.contacts[0]).toMatchObject({ un1t_user_id: NEW_USER, email: 'keep@example.test' })
    expect(calls.find((c) => c.table === 'un1t_clients').op).toBe('insert')
    expect(store.un1t_clients[0]).toMatchObject({ location_id: LOC, un1t_user_id: NEW_USER, contact_id: CONTACT, crm_written_at: NOW, synced_at: REQUESTED })
  })

  it('a 23505 on the org link returns conflict un1t_link_conflict and overwrites nothing', async () => {
    const { db, store } = makeDb({ tables: { contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null }, { id: OTHER_CONTACT, organization_id: ORG, un1t_user_id: NEW_USER }] } })
    const out = await applyUn1tWriteToMirror(db, createArgs(), { read: vi.fn(), now })
    expect(out).toMatchObject({ ok: false, conflict: 'un1t_link_conflict' })
    expect(store.contacts.map((c) => c.un1t_user_id)).toEqual([null, NEW_USER])
    expect(store.un1t_clients[0].contact_id).toBeUndefined()
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('un1t-online-write', expect.any(String), expect.objectContaining({ code: 'un1t_link_conflict' }))
  })

  it('a contact already linked to another un1t.online user is a conflict too (never overwritten)', async () => {
    const { db, store } = makeDb({ tables: { contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: 'someone-else' }] } })
    const out = await applyUn1tWriteToMirror(db, createArgs(), { read: vi.fn(), now })
    expect(out).toMatchObject({ ok: false, conflict: 'un1t_link_conflict' })
    expect(store.contacts[0].un1t_user_id).toBe('someone-else')
  })

  it('a contact already linked to this user is fine; a client row the sync already brought is kept', async () => {
    const { db, store } = makeDb({
      tables: {
        contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: NEW_USER }],
        un1t_clients: [{ id: 'cl-x', location_id: LOC, un1t_user_id: NEW_USER, status: 'active', credit_balance: 2 }],
      },
    })
    const out = await applyUn1tWriteToMirror(db, createArgs(), { read: vi.fn(), now })
    expect(out).toEqual({ ok: true })
    expect(store.un1t_clients).toHaveLength(1)
    expect(store.un1t_clients[0]).toMatchObject({ status: 'active', credit_balance: 2 })
  })

  it('a failed link write is ok:false with an ids-only logError', async () => {
    const { db } = makeDb({ tables: { contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null }] }, fail: { 'contacts.update': { code: '57014', message: 'person@example.test' } } })
    const out = await applyUn1tWriteToMirror(db, createArgs(), { read: vi.fn(), now })
    expect(out.ok).toBe(false)
    expect(logError).toHaveBeenCalledWith('un1t-online-write', expect.any(String), expect.objectContaining({ code: '57014', ledgerId: 'led-c' }))
    expect(JSON.stringify(logError.mock.calls)).not.toContain('example.test')
  })
})

describe('the rest', () => {
  it('checkout writes nothing', async () => {
    const { db, calls } = makeDb()
    await expect(applyUn1tWriteToMirror(db, { op: 'checkout', locationId: LOC }, { read: vi.fn(), now })).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(0)
  })

  it('never touches contact_memberships', async () => {
    const { db, calls } = makeDb({ tables: { contacts: [{ id: CONTACT, organization_id: ORG, un1t_user_id: null }], un1t_clients: [client()] } })
    const read = readFrom({ [CREDITS]: { balance: 1 }, [`/bookings/${BOOKING}`]: picked({ status: 'cancelled' }) })
    await applyUn1tWriteToMirror(db, bookArgs(), { read, now })
    await applyUn1tWriteToMirror(db, bookArgs({ op: 'cancel' }), { read, now })
    await applyUn1tWriteToMirror(db, { op: 'create_client', locationId: LOC, contactId: CONTACT, un1tUserId: NEW_USER, studioId: STUDIO, data: null }, { read, now })
    expect(tablesTouched(calls)).not.toContain('contact_memberships')
    expect(tablesTouched(calls).sort()).toEqual(['contacts', 'un1t_bookings', 'un1t_clients'])
  })

  it('an unknown op, or the trial (Task 10), is a programming error', async () => {
    const { db } = makeDb()
    await expect(applyUn1tWriteToMirror(db, { op: 'refund', locationId: LOC }, { read: vi.fn(), now })).rejects.toBeInstanceOf(TypeError)
    await expect(applyUn1tWriteToMirror(db, { op: 'trial', locationId: LOC }, { read: vi.fn(), now })).rejects.toBeInstanceOf(TypeError)
  })

  it('log lines carry only the contract fields', async () => {
    const { db } = makeDb({ fail: { 'un1t_bookings.upsert': { code: 'XX000' }, 'un1t_clients.update': { code: 'XX001' } } })
    await applyUn1tWriteToMirror(db, bookArgs(), { read: readFrom({ [CREDITS]: { balance: 1 } }), now })
    for (const [mod, , meta] of [...logError.mock.calls, ...logWarn.mock.calls, ...logInfo.mock.calls]) {
      expect(mod).toBe('un1t-online-write')
      for (const k of Object.keys(meta)) expect(ALLOWED_LOG_FIELDS.has(k)).toBe(true)
    }
  })
})
