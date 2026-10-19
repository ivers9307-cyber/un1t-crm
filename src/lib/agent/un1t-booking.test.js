// MIAHATCH.5 Task 16 — book_class at a un1t.online studio (Hatch Street)
// through spec D's book. un1t.online is never called: D's write primitives
// are fakes (fakeUn1tWrite), the live member reads go through fakeUn1tReader,
// and the mirror is a recording fake db. Fictional ids only (the repo is public).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ book: null, reader: null }))

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  const { vi: v } = await import('vitest')
  h.book = v.fn()
  return fakeUn1tWrite({ book: h.book })['@/lib/un1t-online-write-ops']()
})
// The refusal table is empty until the MIA TEST run fills it (PR 6); the tests
// classify through it with a fictional table, the way it will be filled.
vi.mock('@/lib/un1t-online-write-judge', async (importOriginal) => {
  const actual = await importOriginal()
  const TABLE = Object.freeze({ TEST_CLASS_FULL: 'class_full', TEST_NO_CREDITS: 'no_credits' })
  return { ...actual, classifyRefusal: (r) => actual.classifyRefusal(r, TABLE) }
})
vi.mock('./un1t-member-read', async (importOriginal) => ({
  ...(await importOriginal()),
  openUn1tMemberReader: vi.fn(async () => h.reader),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import { UN1T_WRITE_CODES as C } from '@/lib/un1t-online-write'
import { logError, logWarn } from '@/lib/log'
import { fakeUn1tReader } from './un1t-fakes.test-helpers'
import { openUn1tMemberReader } from './un1t-member-read'
import { notifyAgentApprovalRequest } from './approval-notify'
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { DEFAULT_PURCHASE_OFFER_INTRO_TEXT, DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT } from './default-copy'
import { formatClassTime } from './dublin-format'
import { un1tBookClass, un1tBookOutcome, relayedStartMatches, un1tStudioForEvent } from './un1t-booking'

// Fictional ids.
const HATCH = 'a1000000-0000-0000-0000-000000000002'
const STILLORGAN = 'a1000000-0000-0000-0000-000000000001'
const HATCH_CONTACT = 'c1000000-0000-0000-0000-000000000002'
const SIBLING_CONTACT = 'c1000000-0000-0000-0000-000000000003'
const USER = 'u-test-1'
const EVENT = 'e0000000-0000-4000-8000-000000000001'
const ZONE = 'Europe/Dublin'
const BOOKING_URL = 'https://hatch.example.test/book'
const NOW = Date.parse('2026-10-20T09:00:00Z')
const STARTS = '2026-10-23T18:30:00Z'
const LABEL = formatClassTime(Date.parse(STARTS) / 1000, ZONE) // "Fri 23 Oct, 19:30"
const SYNCED = '2026-10-20T08:55:00Z'

const hatch = (extra = {}) => ({
  locationId: HATCH, name: 'UN1T Hatch Street', providerKey: 'un1t_online',
  active: true, answerable: true, contactIds: [HATCH_CONTACT], un1tUserId: USER, ...extra,
})
const event = (over = {}) => ({
  location_id: HATCH, un1t_id: EVENT, title: 'Fictional Hatch HIIT', starts_at: STARTS, status: 'scheduled', synced_at: SYNCED, ...over,
})
const done = (over = {}) => ({ verdict: 'done', sent: true, id: 'bk-new', code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-1', ...over })
const refused = (code, message = null, over = {}) => ({ verdict: 'refused', sent: false, id: null, code, message, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-1', ...over })
const unknown = (over = {}) => ({ verdict: 'unknown', sent: true, id: null, code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-1', ...over })

// A recording fake db: every .eq/.in/.gte/.lte/.contains filters, order and
// range work, inserts get an id and land in the table, updates apply.
function fakeDb(tables = {}, { fail = {} } = {}) {
  const data = { un1t_events: [event()], un1t_bookings: [], un1t_subscriptions: [], agent_membership_requests: [], ...tables }
  const inserts = []
  const updates = []
  let next = 1
  const from = (table) => {
    const st = { op: 'select', cols: null, filters: [], order: null, range: null, limit: null, single: false, row: null, patch: null }
    const pick = (rows) => rows.filter((r) => st.filters.every((f) => f(r)))
    const finish = () => {
      if (fail[table]?.[st.op]) return { data: null, error: { message: 'fictional failure', code: 'XX000' } }
      if (st.op === 'insert') {
        const id = `req-${next++}`
        inserts.push({ table, id, row: st.row })
        data[table] = [...(data[table] || []), { id, ...st.row }]
        return { data: st.single ? { id } : [{ id }], error: null }
      }
      if (st.op === 'update') {
        const hit = pick(data[table] || [])
        updates.push({ table, patch: st.patch, ids: hit.map((r) => r.id) })
        for (const r of hit) Object.assign(r, st.patch)
        return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      let rows = pick(data[table] || [])
      if (st.order) {
        const [col, asc] = st.order
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1)
      if (st.limit != null) rows = rows.slice(0, st.limit)
      return { data: st.single ? (rows[0] ?? null) : rows, error: null }
    }
    const b = {
      select: (cols) => { if (st.op === 'select') st.cols = cols; return b },
      insert: (row) => { st.op = 'insert'; st.row = row; return b },
      update: (patch) => { st.op = 'update'; st.patch = patch; return b },
      eq: (c, v) => { st.filters.push((r) => r[c] === v); return b },
      in: (c, vs) => { st.filters.push((r) => vs.includes(r[c])); return b },
      gte: (c, v) => { st.filters.push((r) => r[c] >= v); return b },
      lte: (c, v) => { st.filters.push((r) => r[c] <= v); return b },
      contains: (c, obj) => { st.filters.push((r) => Object.entries(obj).every(([k, v]) => r[c]?.[k] === v)); return b },
      order: (c, { ascending = true } = {}) => { st.order = [c, ascending]; return b },
      range: (a, z) => { st.range = [a, z]; return b },
      limit: (n) => { st.limit = n; return b },
      maybeSingle: () => { st.single = true; return b },
      single: () => { st.single = true; return b },
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
  }
  return { db: { from }, data, inserts, updates }
}

const HATCH_SETTINGS = { booking_mode: 'auto', booking_url: BOOKING_URL }
function ctxFor(db, { settings = HATCH_SETTINGS, threadLocationId = HATCH, verifiedContactId = HATCH_CONTACT } = {}) {
  return {
    db, locationId: threadLocationId, zone: ZONE, verifiedContactId, contactId: verifiedContactId,
    channel: 'whatsapp', conversationId: 'conv-1', nameHint: 'Fictional Member',
    settings: threadLocationId === HATCH ? settings : { booking_mode: 'auto' },
    actionStudio: vi.fn(async (loc) => (loc === HATCH ? settings : null)),
    turn: { block: 'un1t_full', channel: 'whatsapp', un1tWrites: true, answerable: [hatch()] },
  }
}
const input = (over = {}) => ({ event_id: `un1t:${EVENT}`, class_name: 'Fictional Hatch HIIT', class_time: LABEL, starts_at: LABEL, ...over })
const deps = (over = {}) => ({ now: () => NOW, ...over })
const entitled = () => fakeUn1tReader({ ledger: { balance: 4, is_unlimited: false } })
const empty = () => fakeUn1tReader({ ledger: { balance: 0, is_unlimited: false } })
const requestRows = (inserts) => inserts.filter((i) => i.table === 'agent_membership_requests')
const lastUpdate = (updates) => updates.filter((u) => u.table === 'agent_membership_requests').at(-1)

beforeEach(() => {
  vi.clearAllMocks()
  h.reader = entitled()
  h.book.mockReset()
  h.book.mockResolvedValue(done())
})

describe('un1tBookOutcome (pure)', () => {
  it('maps D\'s verdicts', () => {
    expect(un1tBookOutcome(done())).toBe('booked')
    expect(un1tBookOutcome(done({ alreadyBooked: true, id: null }))).toBe('booked')
    expect(un1tBookOutcome(done({ recovered: 'landed_after_5xx' }))).toBe('booked')
    expect(un1tBookOutcome(refused('TEST_CLASS_FULL', 'Class is full'))).toBe('class_full')
    expect(un1tBookOutcome(refused('TEST_NO_CREDITS', 'No credits'))).toBe('no_credits')
    expect(un1tBookOutcome(refused(C.WRITES_OFF))).toBe('writes_off')
    expect(un1tBookOutcome(refused(C.PERMISSION_MISSING))).toBe('writes_off')
    for (const code of [C.RATE_BUDGET, C.RATE_LIMITED, C.ATTEMPT_IN_FLIGHT, C.PERMISSIONS_UNREADABLE]) {
      expect(un1tBookOutcome(refused(code, null, { retryable: true }))).toBe('retry')
      expect(un1tBookOutcome(refused(code))).toBe('retry')
    }
    expect(un1tBookOutcome(refused('SOMETHING_NEW', 'Member is suspended'))).toBe('card_rejected')
    expect(un1tBookOutcome(refused(C.AUTH))).toBe('card_rejected')
    expect(un1tBookOutcome(unknown())).toBe('card_unknown')
    expect(un1tBookOutcome(unknown({ code: C.ALREADY_BOOKED_UNVERIFIED }))).toBe('card_unknown')
    expect(un1tBookOutcome(null)).toBe('card_unknown')
  })

  it('a refusal that only SAYS "already booked" is never booked (controller: booked only on D\'s done or the live list)', () => {
    expect(un1tBookOutcome(refused('E1', 'You are already booked into another class'))).toBe('card_rejected')
  })
})

describe('relayedStartMatches (pure, Review Focus 4)', () => {
  it('matches the studio-zone label, ignoring case, spaces and commas', () => {
    expect(relayedStartMatches(STARTS, LABEL, ZONE)).toBe(true)
    expect(relayedStartMatches(STARTS, '  fri 23 oct 19:30 ', ZONE)).toBe(true)
    expect(relayedStartMatches(STARTS, 'Fri 23 Oct, 18:30', ZONE)).toBe(false)
    expect(relayedStartMatches(STARTS, '', ZONE)).toBe(false)
    expect(relayedStartMatches(STARTS, null, ZONE)).toBe(false)
    expect(relayedStartMatches('not a date', LABEL, ZONE)).toBe(false)
  })

  it('across the October DST change (25 Oct 2026, Europe/Dublin): only the label in the studio zone after the change matches', () => {
    const afterChange = '2026-10-25T07:00:00Z' // 07:00 GMT, the clocks went back at 02:00 IST
    expect(formatClassTime(Date.parse(afterChange) / 1000, ZONE)).toBe('Sun 25 Oct, 07:00')
    expect(relayedStartMatches(afterChange, 'Sun 25 Oct, 07:00', ZONE)).toBe(true)
    // Rendered with the summer offset still applied: an hour out.
    expect(relayedStartMatches(afterChange, 'Sun 25 Oct, 08:00', ZONE)).toBe(false)
    // The same wall time the week before (summer time): another day.
    expect(relayedStartMatches(afterChange, 'Sun 18 Oct, 07:00', ZONE)).toBe(false)
    // An ISO relay is compared as a label in the zone too.
    expect(relayedStartMatches(afterChange, '2026-10-25T07:00:00Z', ZONE)).toBe(true)
    expect(relayedStartMatches(afterChange, '2026-10-25T07:00:00+01:00', ZONE)).toBe(false)
    expect(relayedStartMatches(afterChange, '2026-10-25T08:00:00+0100', ZONE)).toBe(true)
  })

  it('an ISO relay without an offset is refused (Date.parse would read it in the host zone)', () => {
    const afterChange = '2026-10-25T07:00:00Z'
    expect(relayedStartMatches(afterChange, '2026-10-25T07:00:00', ZONE)).toBe(false)
    expect(relayedStartMatches(afterChange, '2026-10-25T07:00', ZONE)).toBe(false)
    expect(relayedStartMatches(afterChange, '2026-10-25T07:00:00.000Z', ZONE)).toBe(true)
  })

  it('a Stillorgan label relayed on a Hatch id does not match the Hatch class', () => {
    // The member asked for "the 7am"; Stillorgan's is at 07:00, Hatch's at 06:30.
    const hatchStarts = '2026-10-26T06:30:00Z'
    expect(relayedStartMatches(hatchStarts, 'Mon 26 Oct, 07:00', ZONE)).toBe(false)
    expect(relayedStartMatches(hatchStarts, 'Mon 26 Oct, 06:30', ZONE)).toBe(true)
  })
})

describe('un1tBookClass', () => {
  it('done -> actioned + booked; alreadyBooked and recovered also booked', async () => {
    for (const result of [done(), done({ alreadyBooked: true, id: null }), done({ recovered: 'landed_after_5xx' })]) {
      h.reader = entitled()
      h.book.mockResolvedValueOnce(result)
      const { db, inserts, updates } = fakeDb()
      const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
      expect(r).toEqual({ booked: true, class_name: 'Fictional Hatch HIIT', class_time: LABEL })
      const [row] = requestRows(inserts)
      expect(row.row).toMatchObject({ location_id: HATCH, contact_id: HATCH_CONTACT, kind: 'class_booking', status: 'pending', channel: 'whatsapp', conversation_id: 'conv-1' })
      expect(row.row.details).toEqual({
        provider: 'un1t_online', origin: 'mia', reason: 'mia_booking', event_id: EVENT, un1t_user_id: USER,
        executing_contact_id: HATCH_CONTACT, starts_at: new Date(STARTS).toISOString(), class_name: 'Fictional Hatch HIIT',
        class_time: LABEL, mode: 'auto', stage: 'executing',
      })
      const fin = lastUpdate(updates)
      expect(fin.ids).toEqual([row.id])
      expect(fin.patch.status).toBe('actioned')
      expect(fin.patch.details).toMatchObject({ provider: 'un1t_online', un1t_write_id: 'led-1', result: { verdict: 'done' } })
      expect(fin.patch.details.stage).toBeUndefined()
      expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
    }
  })

  it('already in live bookings -> booked, no book() call', async () => {
    h.reader = fakeUn1tReader({ bookings: [{ id: 'bk-9', event_id: EVENT, status: 'booked' }], ledger: { balance: 0, is_unlimited: false } })
    const { db, inserts } = fakeDb()
    expect(await un1tBookClass(ctxFor(db), input(), hatch(), deps())).toEqual({ booked: true, already_booked: true, class_name: 'Fictional Hatch HIIT', class_time: LABEL })
    expect(h.book).not.toHaveBeenCalled()
    expect(inserts).toEqual([])

    // A cancelled live row is not a booking.
    h.reader = fakeUn1tReader({ bookings: [{ id: 'bk-9', event_id: EVENT, status: 'cancelled' }], ledger: { balance: 2, is_unlimited: false } })
    const second = fakeDb()
    expect(await un1tBookClass(ctxFor(second.db), input(), hatch(), deps())).toMatchObject({ booked: true })
    expect(h.book).toHaveBeenCalledTimes(1)

    // The live read failed: the (stale) mirror's booked row is NOT a verdict;
    // D's book decides (here it refuses, so a card, never "booked").
    const mirrorBooked = [{ location_id: HATCH, un1t_user_id: USER, event_id: EVENT, status: 'booked', un1t_id: 'bk-9' }]
    h.book.mockClear()
    h.reader = fakeUn1tReader({ fail: 503 })
    h.book.mockResolvedValueOnce(refused('E1', 'Already booked'))
    const third = fakeDb({ un1t_bookings: mirrorBooked })
    const r3 = await un1tBookClass(ctxFor(third.db), input(), hatch(), deps())
    expect(r3.booked).toBe(false)
    expect(r3.already_booked).toBeUndefined()
    expect(h.book).toHaveBeenCalledTimes(1)
  })

  it('a TRUNCATED live list without the class falls to book(), never to the mirror', async () => {
    const mirrorBooked = [{ location_id: HATCH, un1t_user_id: USER, event_id: EVENT, status: 'booked', un1t_id: 'bk-9' }]
    h.reader = fakeUn1tReader({ bookings: [{ id: 'bk-1', event_id: 'e-other', status: 'booked' }], ledger: { balance: 2, is_unlimited: false }, truncated: true })
    h.book.mockResolvedValueOnce(unknown())
    const { db } = fakeDb({ un1t_bookings: mirrorBooked })
    const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
    expect(h.book).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ booked: false, handoff: true, reason: 'un1t_outcome_unknown' })

    // A truncated live list that DOES show the class is still a live answer.
    h.book.mockClear()
    h.reader = fakeUn1tReader({ bookings: [{ id: 'bk-9', event_id: EVENT, status: 'booked' }], ledger: { balance: 2, is_unlimited: false }, truncated: true })
    const f = fakeDb()
    expect(await un1tBookClass(ctxFor(f.db), input(), hatch(), deps())).toMatchObject({ booked: true, already_booked: true })
    expect(h.book).not.toHaveBeenCalled()
  })

  it('credit_unlimited true and balance 0 -> books, no upsell', async () => {
    h.reader = fakeUn1tReader({ ledger: { balance: 0, is_unlimited: true } })
    const offersFor = vi.fn(async () => ({ offers: [{ offer_id: 'o-1' }], trial_available: false }))
    const { db } = fakeDb()
    const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps({ offersFor }))
    expect(r).toMatchObject({ booked: true })
    expect(h.book).toHaveBeenCalledTimes(1)
    expect(offersFor).not.toHaveBeenCalled()
  })

  it('ledger unreadable but live subscription in mirror -> books; ledger unreadable and nothing -> proceeds, un1t.online arbitrates', async () => {
    const offersFor = vi.fn(async () => ({ offers: [{ offer_id: 'o-1' }], trial_available: false }))
    const sub = { location_id: HATCH, un1t_user_id: USER, status: 'active', un1t_id: 's-1' }
    for (const [reader, subs] of [
      [fakeUn1tReader({ ledger: null }), [sub]],
      [fakeUn1tReader({ fail: 503 }), [sub]],
      [fakeUn1tReader({ ledger: null }), []],
      [fakeUn1tReader({ fail: 'budget' }), []],
    ]) {
      h.reader = reader
      h.book.mockClear()
      const { db } = fakeDb({ un1t_subscriptions: subs })
      expect(await un1tBookClass(ctxFor(db), input(), hatch(), deps({ offersFor }))).toMatchObject({ booked: true })
      expect(h.book).toHaveBeenCalledTimes(1)
    }
    // A readable zero ledger with a live subscription books too.
    h.reader = empty()
    h.book.mockClear()
    const { db } = fakeDb({ un1t_subscriptions: [sub] })
    expect(await un1tBookClass(ctxFor(db), input(), hatch(), deps({ offersFor }))).toMatchObject({ booked: true })
    expect(offersFor).not.toHaveBeenCalled()
  })

  it('confirmed nothing + offers -> needs_purchase with offers; no offers -> no_credits card + deterministic handoff', async () => {
    const offers = [{ offer_id: 'o-1', title: '5 Class Pack', price_label: '€60', credits: 5, blurb: null }]
    h.reader = empty()
    const withOffers = fakeDb()
    const r = await un1tBookClass(ctxFor(withOffers.db), input(), hatch(), deps({ offersFor: async () => ({ offers, trial_available: false }) }))
    expect(r).toEqual({ booked: false, needs_purchase: true, offers, trial_available: false, wording: DEFAULT_PURCHASE_OFFER_INTRO_TEXT })
    expect(h.book).not.toHaveBeenCalled()
    expect(withOffers.inserts).toEqual([])

    // PR 5: no offer list exists yet, so the default is the no_credits card.
    h.reader = empty()
    const none = fakeDb()
    const r2 = await un1tBookClass(ctxFor(none.db), input(), hatch(), deps())
    expect(r2).toMatchObject({ booked: false, no_credits: true })
    expect(h.book).not.toHaveBeenCalled()
    const [card] = requestRows(none.inserts)
    expect(card.row).toMatchObject({ location_id: HATCH, contact_id: HATCH_CONTACT, kind: 'class_booking', status: 'pending' })
    expect(card.row.details).toMatchObject({ provider: 'un1t_online', origin: 'mia', reason: 'no_credits', event_id: EVENT, un1t_user_id: USER, executing_contact_id: HATCH_CONTACT })
    expect(notifyAgentApprovalRequest).toHaveBeenCalledWith(none.db, expect.objectContaining({ requestId: card.id, locationId: HATCH, kind: 'class_booking' }))

    // A second ask for the same class reuses the card.
    h.reader = empty()
    const again = await un1tBookClass(ctxFor(none.db), input(), hatch(), deps())
    expect(again).toMatchObject({ no_credits: true })
    expect(requestRows(none.inserts)).toHaveLength(1)
  })

  it('refused class_full (classifyRefusal) -> failed, relayed, offer the next slot; event cancelled or started -> refused by pre-flight, no book()', async () => {
    h.book.mockResolvedValueOnce(refused('TEST_CLASS_FULL', 'Class is full'))
    const { db, updates } = fakeDb()
    const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
    expect(r).toMatchObject({ booked: false, reason: 'class_full' })
    expect(r.message).toMatch(/full/)
    expect(r.message).toMatch(/list_upcoming_classes/)
    expect(lastUpdate(updates).patch.status).toBe('failed')
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()

    h.book.mockClear()
    const older = '2026-10-20T08:00:00Z'
    for (const [events, reason] of [
      [[event({ status: 'cancelled' })], 'no_longer_available'],
      [[event({ status: 'completed' })], 'already_started'],
      [[event({ starts_at: '2026-10-20T08:30:00Z' })], 'already_started'],
      [[], 'no_longer_available'],
      // Removed in un1t.online: the latest pull did not see it (#2137).
      [[event({ synced_at: older }), event({ un1t_id: 'e-other', synced_at: SYNCED })], 'no_longer_available'],
      [[event({ location_id: STILLORGAN })], 'no_longer_available'],
    ]) {
      const f = fakeDb({ un1t_events: events })
      const res = await un1tBookClass(ctxFor(f.db), input(), hatch(), deps())
      expect(res).toMatchObject({ booked: false, error: 'class_unavailable', reason })
      expect(f.inserts).toEqual([])
    }
    expect(h.book).not.toHaveBeenCalled()
  })

  it('retryable refusal (UN1T_RATE_BUDGET, UN1T_ATTEMPT_IN_FLIGHT) -> try again shortly, no card', async () => {
    for (const code of [C.RATE_BUDGET, C.ATTEMPT_IN_FLIGHT, C.RATE_LIMITED, C.PERMISSIONS_UNREADABLE]) {
      h.reader = entitled()
      h.book.mockResolvedValueOnce(refused(code, null, { retryable: true }))
      const { db, inserts, updates } = fakeDb()
      const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
      expect(r).toMatchObject({ booked: false, try_again: true })
      expect(r.message).toMatch(/try again/)
      expect(requestRows(inserts)).toHaveLength(1)
      // The write-ahead row is closed out, never left pending/executing.
      const fin = lastUpdate(updates)
      expect(fin.patch.status).toBe('failed')
      expect(fin.patch.details).toMatchObject({ reason: 'un1t_retry', result: { code } })
      expect(fin.patch.details.stage).toBeUndefined()
    }
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('refused no_credits (classifyRefusal) after pre-flight -> needs_purchase', async () => {
    const offers = [{ offer_id: 'o-1', title: '5 Class Pack', price_label: '€60', credits: 5, blurb: null }]
    h.book.mockResolvedValueOnce(refused('TEST_NO_CREDITS', 'No credits left'))
    const withOffers = fakeDb()
    const r = await un1tBookClass(ctxFor(withOffers.db), input(), hatch(), deps({ offersFor: async () => ({ offers, trial_available: false }) }))
    expect(r).toMatchObject({ booked: false, needs_purchase: true, offers })
    expect(lastUpdate(withOffers.updates).patch.status).toBe('failed')
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()

    // No offers (PR 5): the write-ahead row becomes the no_credits card.
    h.reader = entitled()
    h.book.mockResolvedValueOnce(refused('TEST_NO_CREDITS', 'No credits left'))
    const none = fakeDb()
    const r2 = await un1tBookClass(ctxFor(none.db), input(), hatch(), deps())
    expect(r2).toMatchObject({ booked: false, no_credits: true })
    const fin = lastUpdate(none.updates)
    expect(fin.patch.status).toBe('pending')
    expect(fin.patch.details).toMatchObject({ provider: 'un1t_online', reason: 'no_credits', un1t_write_id: 'led-1' })
    expect(notifyAgentApprovalRequest).toHaveBeenCalledTimes(1)
  })

  it('refused unmapped -> card booking_rejected quoting un1t.online words + booking_issue_handoff_text', async () => {
    h.book.mockResolvedValueOnce(refused('SOMETHING_NEW', 'Member account is suspended'))
    const { db, updates } = fakeDb()
    const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
    expect(r).toMatchObject({ booked: false, handoff: true, reason: 'booking_rejected' })
    expect(r.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
    expect(r.booked).not.toBe(true)
    const fin = lastUpdate(updates)
    expect(fin.patch.status).toBe('pending')
    expect(fin.patch.details).toMatchObject({ reason: 'booking_rejected', un1t_write_id: 'led-1', result: { verdict: 'refused', code: 'SOMETHING_NEW', message: 'Member account is suspended' } })
    expect(fin.patch.details.summary).toContain('"Member account is suspended"')
    expect(notifyAgentApprovalRequest).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: HATCH, kind: 'class_booking' }))

    // The studio's own operator text wins.
    h.reader = entitled()
    h.book.mockResolvedValueOnce(refused('SOMETHING_NEW', 'x'))
    const op = fakeDb()
    const r2 = await un1tBookClass(ctxFor(op.db, { settings: { ...HATCH_SETTINGS, booking_issue_handoff_text: 'Fictional: the team will sort your account.' } }), input(), hatch(), deps())
    expect(r2.message).toContain('Fictional: the team will sort your account.')
  })

  it('unknown -> card un1t_outcome_unknown + handoff text; result never booked: true', async () => {
    for (const result of [unknown(), unknown({ code: C.ALREADY_BOOKED_UNVERIFIED }), refused('E1', 'You are already booked')]) {
      h.reader = entitled()
      h.book.mockResolvedValueOnce(result)
      const { db, updates } = fakeDb()
      const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
      expect(r.booked).toBe(false)
      expect(r).toMatchObject({ handoff: true })
      expect(r.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      expect(lastUpdate(updates).patch.status).toBe('pending')
      expect(JSON.stringify(r)).not.toMatch(/"booked":true/)
    }
    h.reader = entitled()
    h.book.mockResolvedValueOnce(unknown())
    const { db, updates } = fakeDb()
    expect(await un1tBookClass(ctxFor(db), input(), hatch(), deps())).toMatchObject({ reason: 'un1t_outcome_unknown' })
    expect(lastUpdate(updates).patch.details).toMatchObject({ reason: 'un1t_outcome_unknown', un1t_write_id: 'led-1' })
  })

  it('UN1T_WRITES_OFF / UN1T_PERMISSION_MISSING -> chat_booking_unavailable_text, no card', async () => {
    for (const code of [C.WRITES_OFF, C.PERMISSION_MISSING]) {
      h.reader = entitled()
      h.book.mockResolvedValueOnce(refused(code, 'staff words'))
      const { db, updates } = fakeDb()
      const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
      const text = DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT.replace('{studio}', 'UN1T Hatch Street').replace('{link}', BOOKING_URL)
      expect(r).toEqual({ booked: false, handoff: true, reason: 'writes_off', chat_booking_unavailable: true, text })
      expect(lastUpdate(updates).patch.status).toBe('failed')
    }
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('draft booking_mode at the action studio -> pending class_booking card, no book()', async () => {
    // A Hatch booking on a Stillorgan thread: Hatch's mode decides, not the thread's.
    const { db, inserts } = fakeDb()
    const ctx = ctxFor(db, { settings: { ...HATCH_SETTINGS, booking_mode: 'draft' }, threadLocationId: STILLORGAN })
    const r = await un1tBookClass(ctx, input(), hatch(), deps())
    expect(r).toMatchObject({ booked: false, pending_approval: true })
    expect(h.book).not.toHaveBeenCalled()
    const [card] = requestRows(inserts)
    expect(card.row).toMatchObject({ location_id: HATCH, kind: 'class_booking', status: 'pending' })
    expect(card.row.details).toMatchObject({ provider: 'un1t_online', origin: 'mia', reason: 'mia_booking', event_id: EVENT, mode: 'draft' })
    expect(card.row.details.stage).toBeUndefined()
    expect(notifyAgentApprovalRequest).toHaveBeenCalledWith(db, expect.objectContaining({ requestId: card.id, locationId: HATCH }))
    expect(ctx.actionStudio).toHaveBeenCalledWith(HATCH)

    // Unreadable settings at another studio: a card, never an unsanctioned auto booking.
    const f = fakeDb()
    const unread = ctxFor(f.db, { threadLocationId: STILLORGAN })
    unread.actionStudio = vi.fn(async () => null)
    expect(await un1tBookClass(unread, input(), hatch(), deps())).toMatchObject({ pending_approval: true })
    expect(h.book).not.toHaveBeenCalled()
  })

  it('passes a bare eventId (prefix stripped), origin mia and originRef = request id; never bypassCredit', async () => {
    const { db, inserts } = fakeDb()
    await un1tBookClass(ctxFor(db), input(), hatch({ contactIds: [SIBLING_CONTACT, HATCH_CONTACT] }), deps())
    expect(h.book).toHaveBeenCalledTimes(1)
    const [passedDb, args] = h.book.mock.calls[0]
    expect(passedDb).toBe(db)
    const [row] = requestRows(inserts)
    expect(args).toEqual({ locationId: HATCH, contactId: HATCH_CONTACT, un1tUserId: USER, eventId: EVENT, origin: 'mia', originRef: row.id, actor: null })
    expect(JSON.stringify(h.book.mock.calls)).not.toMatch(/bypassCredit|forceRefund|un1t:/)
    // The verified contact is the executing one when it holds the account.
    expect(row.row.details.executing_contact_id).toBe(HATCH_CONTACT)

    // Verified on a contact without the account (a Stillorgan sibling): the
    // studio's own contact runs the write and is the card's contact.
    h.book.mockClear()
    const f = fakeDb()
    await un1tBookClass(ctxFor(f.db, { verifiedContactId: 'c-elsewhere', threadLocationId: STILLORGAN }), input(), hatch(), deps())
    expect(h.book.mock.calls[0][1].contactId).toBe(HATCH_CONTACT)
    expect(requestRows(f.inserts)[0].row.contact_id).toBe(HATCH_CONTACT)
  })

  it('relayed starts_at mismatch refused, incl. a label across the Oct DST change and a Stillorgan label on a Hatch id', async () => {
    const dstStarts = '2026-10-25T07:00:00Z'
    for (const [starts, relayed] of [
      [dstStarts, 'Sun 25 Oct, 08:00'],
      ['2026-10-26T06:30:00Z', 'Mon 26 Oct, 07:00'],
      [STARTS, undefined],
      [STARTS, 'tomorrow evening'],
    ]) {
      const { db, inserts } = fakeDb({ un1t_events: [event({ starts_at: starts })] })
      const r = await un1tBookClass(ctxFor(db), input({ starts_at: relayed }), hatch(), deps())
      expect(r).toMatchObject({ booked: false, error: 'class_unavailable', reason: 'starts_at_mismatch' })
      expect(inserts).toEqual([])
    }
    expect(h.book).not.toHaveBeenCalled()
    const { db } = fakeDb({ un1t_events: [event({ starts_at: dstStarts })] })
    expect(await un1tBookClass(ctxFor(db), input({ starts_at: 'Sun 25 Oct, 07:00' }), hatch(), deps())).toMatchObject({ booked: true, class_time: 'Sun 25 Oct, 07:00' })
  })

  it('no un1t_user_id -> not_linked with booking_url', async () => {
    const { db, inserts } = fakeDb()
    const r = await un1tBookClass(ctxFor(db), input(), hatch({ un1tUserId: undefined }), deps())
    expect(r).toMatchObject({ booked: false, not_linked: true, booking_url: BOOKING_URL })
    const f = fakeDb()
    const noLink = await un1tBookClass(ctxFor(f.db, { settings: { booking_mode: 'auto' } }), input(), hatch({ un1tUserId: undefined }), deps())
    expect(noLink).toMatchObject({ not_linked: true, booking_url: null })
    expect(h.book).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('not verified, or a id that is not a un1t one: nothing is read or booked', async () => {
    const { db } = fakeDb()
    expect(await un1tBookClass(ctxFor(db, { verifiedContactId: null }), input(), hatch(), deps())).toMatchObject({ error: 'not_verified' })
    expect(await un1tBookClass(ctxFor(db), input({ event_id: 'un1t:' }), hatch(), deps())).toMatchObject({ error: 'class_unavailable' })
    expect(openUn1tMemberReader).not.toHaveBeenCalled()
    expect(h.book).not.toHaveBeenCalled()
  })

  it('book() rejects before sending -> row failed un1t_book_not_sent, booking_issue_handoff_text, logged without PII', async () => {
    h.book.mockRejectedValueOnce(Object.assign(new Error('ledger insert failed for aoife@example.test'), { name: 'Un1tSettingsReadError', code: '57014' }))
    const { db, updates } = fakeDb()
    const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
    expect(r).toMatchObject({ booked: false, handoff: true, reason: 'un1t_book_not_sent' })
    expect(r.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
    const fin = lastUpdate(updates)
    expect(fin.patch.status).toBe('failed')
    expect(fin.patch.details.reason).toBe('un1t_book_not_sent')
    expect(logError).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ locationId: HATCH, status: null, code: '57014' }))
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/example\.test/)
  })

  it('a write-ahead row that cannot be written: nothing is sent, try again', async () => {
    const { db } = fakeDb({}, { fail: { agent_membership_requests: { insert: true } } })
    const r = await un1tBookClass(ctxFor(db), input(), hatch(), deps())
    expect(r).toMatchObject({ booked: false, try_again: true })
    expect(h.book).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ locationId: HATCH }))
  })

  it('an unreadable timetable row: try again, nothing booked', async () => {
    const { db } = fakeDb({}, { fail: { un1t_events: { select: true } } })
    expect(await un1tBookClass(ctxFor(db), input(), hatch(), deps())).toMatchObject({ booked: false, try_again: true })
    expect(h.book).not.toHaveBeenCalled()
  })

  it('every log line is module mia-un1t with no personal or secret keys', async () => {
    h.book.mockResolvedValueOnce(unknown())
    const { db } = fakeDb()
    await un1tBookClass(ctxFor(db), input({ starts_at: 'Sat 1 Jan, 00:00' }), hatch(), deps())
    await un1tBookClass(ctxFor(db), input(), hatch(), deps())
    for (const [module, , meta] of [...logWarn.mock.calls, ...logError.mock.calls]) {
      expect(module).toBe('mia-un1t')
      expect(Object.keys(meta ?? {}).filter((k) => /email|phone|name|token|url|path/i.test(k))).toEqual([])
    }
  })

  it('no em or en dash in any answer the model reads', async () => {
    const answers = []
    for (const result of [done(), refused('TEST_CLASS_FULL'), refused(C.RATE_BUDGET, null, { retryable: true }), refused('X', 'y'), unknown(), refused(C.WRITES_OFF)]) {
      h.reader = entitled()
      h.book.mockResolvedValueOnce(result)
      answers.push(await un1tBookClass(ctxFor(fakeDb().db), input(), hatch(), deps()))
    }
    h.reader = empty()
    answers.push(await un1tBookClass(ctxFor(fakeDb().db), input(), hatch(), deps()))
    answers.push(await un1tBookClass(ctxFor(fakeDb().db), input({ starts_at: 'x' }), hatch(), deps()))
    answers.push(await un1tBookClass(ctxFor(fakeDb().db), input(), hatch({ un1tUserId: undefined }), deps()))
    answers.push(await un1tBookClass(ctxFor(fakeDb().db, { settings: { booking_mode: 'draft' } }), input(), hatch(), deps()))
    expect(JSON.stringify(answers)).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('un1tStudioForEvent', () => {
  it('one un1t studio is that studio; two are told apart by where the class is', async () => {
    const second = hatch({ locationId: 'a1000000-0000-0000-0000-000000000009', name: 'UN1T Second Studio' })
    const { db } = fakeDb({ un1t_events: [event({ location_id: second.locationId })] })
    expect(await un1tStudioForEvent(db, [hatch()], EVENT)).toEqual(hatch())
    expect(await un1tStudioForEvent(db, [hatch(), second], EVENT)).toEqual(second)
    const glofox = { locationId: STILLORGAN, providerKey: 'glofox' }
    expect(await un1tStudioForEvent(db, [glofox], EVENT)).toBeNull()
    const none = fakeDb({ un1t_events: [] })
    expect(await un1tStudioForEvent(none.db, [hatch(), second], EVENT)).toBeNull()
  })
})
