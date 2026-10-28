// UN1TMOVE.1 — move_class_booking at a un1t.online studio (Hatch Street): one
// D moveBooking call instead of a cancel then a book. un1t.online is never
// called: D's write primitives are fakes, the live member reads go through
// fakeUn1tReader, and the mirror is a recording fake db. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ book: null, cancel: null, moveBooking: null, reader: null, quote: null }))

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  const { vi: v } = await import('vitest')
  h.book = v.fn()
  h.cancel = v.fn()
  h.moveBooking = v.fn()
  return fakeUn1tWrite({ book: h.book, cancel: h.cancel, moveBooking: h.moveBooking })['@/lib/un1t-online-write-ops']()
})
vi.mock('@/lib/un1t-online-approval', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  return fakeUn1tWrite()['@/lib/un1t-online-approval']()
})
vi.mock('@/lib/un1t-online-write-judge', async (importOriginal) => {
  const actual = await importOriginal()
  const TABLE = Object.freeze({ TEST_CLASS_FULL: 'class_full', TEST_NO_CREDITS: 'no_credits', TEST_LATE_CANCEL: 'late_cancel' })
  return { ...actual, classifyRefusal: (r) => actual.classifyRefusal(r, TABLE) }
})
vi.mock('./un1t-member-read', async (importOriginal) => ({
  ...(await importOriginal()),
  openUn1tMemberReader: vi.fn(async () => h.reader),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
vi.mock('@/lib/class-fees-quote', async (importOriginal) => ({
  ...(await importOriginal()),
  lateCancelQuote: vi.fn(async (...args) => (h.quote ? h.quote(...args) : { applies: false, reason: 'fees_off' })),
}))

import { UN1T_WRITE_CODES as C } from '@/lib/un1t-online-write'
import { fakeUn1tReader } from './un1t-fakes.test-helpers'
import { notifyAgentApprovalRequest } from './approval-notify'
import { formatClassTime } from './dublin-format'
import { un1tMoveBooking, un1tMoveOutcome } from './un1t-booking'

const HATCH = 'a1000000-0000-0000-0000-000000000002'
const HATCH_CONTACT = 'c1000000-0000-0000-0000-000000000002'
const USER = 'u-test-1'
const FROM_EVENT = 'e0000000-0000-4000-8000-000000000001'
const TO_EVENT = 'e0000000-0000-4000-8000-000000000002'
const BOOKING = 'b0000000-0000-4000-8000-000000000001'
const ZONE = 'Europe/Dublin'
const NOW = Date.parse('2026-10-20T09:00:00Z')
const FROM_STARTS = '2026-10-23T18:30:00Z'
const TO_STARTS = '2026-10-24T09:00:00Z'
const FROM_LABEL = formatClassTime(Date.parse(FROM_STARTS) / 1000, ZONE)
const TO_LABEL = formatClassTime(Date.parse(TO_STARTS) / 1000, ZONE)
const SYNCED = '2026-10-20T08:55:00Z'

const hatch = (extra = {}) => ({
  locationId: HATCH, name: 'UN1T Hatch Street', providerKey: 'un1t_online',
  active: true, answerable: true, contactIds: [HATCH_CONTACT], un1tUserId: USER, ...extra,
})
const ev = (id, title, starts) => ({ location_id: HATCH, un1t_id: id, title, starts_at: starts, status: 'scheduled', synced_at: SYNCED })
const result = (over = {}) => ({ verdict: 'done', sent: true, id: BOOKING, code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-1', ...over })
const refused = (code, message = null, over = {}) => result({ verdict: 'refused', sent: false, id: null, code, message, ...over })
const bookedRow = (over = {}) => ({ id: BOOKING, event_id: FROM_EVENT, status: 'booked', ...over })
const minput = (over = {}) => ({ booking_id: `un1t:${BOOKING}`, event_id: `un1t:${TO_EVENT}`, starts_at: TO_LABEL, ...over })

function fakeDb(tables = {}) {
  const data = {
    locations: [{ id: HATCH, name: 'UN1T Hatch Street', settings: { un1t_online: {} } }],
    un1t_events: [ev(FROM_EVENT, 'Fictional Hatch HIIT', FROM_STARTS), ev(TO_EVENT, 'Fictional Hatch Strength', TO_STARTS)],
    un1t_bookings: [], agent_membership_requests: [], ...tables,
  }
  const inserts = []
  const updates = []
  let next = 1
  const from = (table) => {
    const st = { op: 'select', filters: [], limit: null, single: false, row: null, patch: null }
    const pick = (rows) => rows.filter((r) => st.filters.every((f) => f(r)))
    const finish = () => {
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
      if (st.limit != null) rows = rows.slice(0, st.limit)
      return { data: st.single ? (rows[0] ?? null) : rows, error: null }
    }
    const b = {
      select: () => b,
      insert: (row) => { st.op = 'insert'; st.row = row; return b },
      update: (patch) => { st.op = 'update'; st.patch = patch; return b },
      eq: (c, v) => { st.filters.push((r) => r[c] === v); return b },
      in: (c, vs) => { st.filters.push((r) => vs.includes(r[c])); return b },
      gte: (c, v) => { st.filters.push((r) => r[c] >= v); return b },
      lte: (c, v) => { st.filters.push((r) => r[c] <= v); return b },
      contains: (c, obj) => { st.filters.push((r) => Object.entries(obj).every(([k, v]) => r[c]?.[k] === v)); return b },
      is: (c, v) => { const [col, key] = c.split('->>'); st.filters.push((r) => (key ? r[col]?.[key] : r[col]) == v); return b },
      order: () => b,
      range: () => b,
      limit: (n) => { st.limit = n; return b },
      maybeSingle: () => { st.single = true; return b },
      single: () => { st.single = true; return b },
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
  }
  return { db: { from }, data, inserts, updates }
}

function ctxFor(db, { settings = { booking_mode: 'auto' }, verifiedContactId = HATCH_CONTACT } = {}) {
  return {
    db, locationId: HATCH, zone: ZONE, verifiedContactId, contactId: verifiedContactId,
    channel: 'whatsapp', conversationId: 'conv-1', nameHint: 'Fictional Member', settings,
    actionStudio: vi.fn(async () => settings),
    turn: { block: 'un1t_full', channel: 'whatsapp', un1tWrites: true, answerable: [hatch()] },
  }
}
const deps = () => ({ now: () => NOW })
const requestRows = (inserts) => inserts.filter((i) => i.table === 'agent_membership_requests')
const lastUpdate = (updates) => updates.filter((u) => u.table === 'agent_membership_requests').at(-1)

beforeEach(() => {
  vi.clearAllMocks()
  h.quote = null
  h.reader = fakeUn1tReader({ bookings: [bookedRow()] })
  h.moveBooking.mockReset()
  h.moveBooking.mockResolvedValue(result())
})

describe('un1tMoveOutcome (pure)', () => {
  it("maps D's move verdicts", () => {
    expect(un1tMoveOutcome(result())).toBe('moved')
    expect(un1tMoveOutcome(result({ recovered: 'landed_after_5xx' }))).toBe('moved')
    expect(un1tMoveOutcome(refused('TEST_CLASS_FULL', 'full'))).toBe('class_full')
    expect(un1tMoveOutcome(refused('TEST_LATE_CANCEL', 'too late'))).toBe('too_late')
    expect(un1tMoveOutcome(refused(C.ALREADY_HAPPENED))).toBe('already_happened')
    expect(un1tMoveOutcome(refused('move_same_class'))).toBe('same_class')
    expect(un1tMoveOutcome(refused('move_late_other_day'))).toBe('late_other_day')
    expect(un1tMoveOutcome(refused('move_window_unreadable', null, { retryable: true }))).toBe('retry')
    expect(un1tMoveOutcome(refused(C.WRITES_OFF))).toBe('writes_off')
    expect(un1tMoveOutcome(refused(C.RATE_BUDGET))).toBe('retry')
    expect(un1tMoveOutcome(refused('SOMETHING_NEW', 'x'))).toBe('card_rejected')
    expect(un1tMoveOutcome(refused('TEST_NO_CREDITS', 'x'))).toBe('card_rejected')
    expect(un1tMoveOutcome(result({ verdict: 'unknown', id: null }))).toBe('card_unknown')
    expect(un1tMoveOutcome(null)).toBe('card_unknown')
  })
})

describe('un1tMoveBooking', () => {
  it('done -> moved, ONE move call (never a cancel or a book), and a write-ahead class_booking row the approval executor can read', async () => {
    const { db, inserts, updates } = fakeDb()
    const r = await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())
    expect(r).toEqual({
      moved: true, class_name: 'Fictional Hatch Strength', class_time: TO_LABEL,
      from_class_name: 'Fictional Hatch HIIT', from_class_time: FROM_LABEL,
    })
    expect(h.moveBooking).toHaveBeenCalledTimes(1)
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.book).not.toHaveBeenCalled()
    const [row] = requestRows(inserts)
    expect(row.row).toMatchObject({ location_id: HATCH, contact_id: HATCH_CONTACT, kind: 'class_booking', status: 'pending' })
    expect(row.row.details).toMatchObject({
      provider: 'un1t_online', origin: 'mia', reason: 'mia_move', event_id: TO_EVENT, un1t_user_id: USER,
      executing_contact_id: HATCH_CONTACT, starts_at: new Date(TO_STARTS).toISOString(), class_name: 'Fictional Hatch Strength',
      move_from_booking_id: BOOKING, move_from_event_id: FROM_EVENT, move_from_class_name: 'Fictional Hatch HIIT',
      move_from_class_time: FROM_LABEL, stage: 'executing',
    })
    expect(h.moveBooking.mock.calls[0][1]).toEqual({
      locationId: HATCH, contactId: HATCH_CONTACT, un1tUserId: USER, bookingId: BOOKING, eventId: TO_EVENT, fromEventId: FROM_EVENT,
      origin: 'mia', originRef: row.id, actor: null,
    })
    const fin = lastUpdate(updates)
    expect(fin.patch.status).toBe('actioned')
    expect(fin.patch.details).toMatchObject({ un1t_write_id: 'led-1', result: { verdict: 'done' } })
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('class full: relayed, the original booking stands, nothing else sent', async () => {
    h.moveBooking.mockResolvedValue(refused('TEST_CLASS_FULL', 'This class is full'))
    const { db, updates } = fakeDb()
    const r = await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())
    expect(r).toMatchObject({ moved: false, reason: 'class_full' })
    expect(r.message).toMatch(/still booked into Fictional Hatch HIIT/)
    expect(lastUpdate(updates).patch.status).toBe('failed')
  })

  it('unknown or an unmapped refusal: the row becomes ONE staff card and Mia hands off, never "moved"', async () => {
    for (const [answer, reason] of [[result({ verdict: 'unknown', id: null }), 'move_outcome_unknown'], [refused('SOMETHING_NEW', 'Suspended'), 'move_rejected']]) {
      vi.clearAllMocks()
      h.moveBooking.mockResolvedValue(answer)
      const { db, updates } = fakeDb()
      const r = await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())
      expect(r).toMatchObject({ moved: false, handoff: true, reason })
      expect(r.message).toMatch(/Never say it is moved/)
      expect(lastUpdate(updates).patch).toMatchObject({ status: 'pending', details: { reason } })
      expect(notifyAgentApprovalRequest).toHaveBeenCalledTimes(1)
    }
  })

  it('draft mode files a pending card (approving it moves the booking), nothing sent', async () => {
    const { db, inserts } = fakeDb()
    const r = await un1tMoveBooking(ctxFor(db, { settings: { booking_mode: 'draft' } }), minput(), hatch(), deps())
    expect(r).toMatchObject({ moved: false, pending_approval: true })
    expect(h.moveBooking).not.toHaveBeenCalled()
    expect(requestRows(inserts)[0].row).toMatchObject({ kind: 'class_booking', status: 'pending', details: { reason: 'mia_move', move_from_booking_id: BOOKING, event_id: TO_EVENT } })
  })

  // UN1TMOVE.2 — inside the window only a class the same studio day.
  it('inside the cancellation window: another studio day is refused with member words, nothing sent or filed', async () => {
    h.quote = vi.fn(async () => ({ applies: true, penalty: 'fee', amountCents: 1000, windowHours: 12, swapMinutes: null }))
    const { db, inserts } = fakeDb()
    const r = await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())
    expect(r).toMatchObject({ moved: false, refused: 'late_other_day' })
    expect(r.message).toMatch(/can only be moved to another class on the same day/)
    expect(h.moveBooking).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('inside the cancellation window: a class later the SAME studio day moves', async () => {
    h.quote = vi.fn(async () => ({ applies: true, penalty: 'fee', amountCents: 1000, windowHours: 12, swapMinutes: null }))
    const LATER = '2026-10-23T20:00:00Z'
    const { db } = fakeDb({ un1t_events: [ev(FROM_EVENT, 'Fictional Hatch HIIT', FROM_STARTS), ev(TO_EVENT, 'Fictional Hatch Strength', LATER)] })
    const r = await un1tMoveBooking(ctxFor(db), minput({ starts_at: formatClassTime(Date.parse(LATER) / 1000, ZONE) }), hatch(), deps())
    expect(r).toMatchObject({ moved: true, class_name: 'Fictional Hatch Strength' })
    expect(h.moveBooking).toHaveBeenCalledTimes(1)
  })

  it("D's late-window refusal (another day) is relayed in the member's words; its unreadable refusal is a try-again", async () => {
    h.moveBooking.mockResolvedValueOnce(refused('move_late_other_day', 'x'))
    let { db } = fakeDb()
    expect(await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())).toMatchObject({ moved: false, refused: 'late_other_day' })
    h.moveBooking.mockResolvedValueOnce(refused('move_window_unreadable', 'x', { retryable: true }))
    ;({ db } = fakeDb())
    expect(await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())).toMatchObject({ moved: false, try_again: true })
  })

  it('the booking not among the live bookings, or an unreadable list: nothing sent', async () => {
    for (const reader of [fakeUn1tReader({ bookings: [bookedRow({ id: 'bk-other' })] }), fakeUn1tReader({ fail: 503 })]) {
      h.reader = reader
      const { db, inserts } = fakeDb()
      const r = await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())
      expect(r).toMatchObject({ moved: false, error: 'MOVE_UNCERTAIN' })
      expect(inserts).toEqual([])
    }
    expect(h.moveBooking).not.toHaveBeenCalled()
  })

  it('already in that class, or already holding it in another booking: nothing sent', async () => {
    h.reader = fakeUn1tReader({ bookings: [bookedRow({ event_id: TO_EVENT })] })
    let { db } = fakeDb()
    expect(await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())).toMatchObject({ moved: false, reason: 'same_class' })
    h.reader = fakeUn1tReader({ bookings: [bookedRow(), { id: 'bk-2', event_id: TO_EVENT, status: 'booked' }] })
    ;({ db } = fakeDb())
    expect(await un1tMoveBooking(ctxFor(db), minput(), hatch(), deps())).toMatchObject({ moved: false, reason: 'already_booked' })
    expect(h.moveBooking).not.toHaveBeenCalled()
  })

  it('a target that is not a un1t class, has gone, or a mismatched time: nothing sent', async () => {
    const { db } = fakeDb()
    expect(await un1tMoveBooking(ctxFor(db), minput({ event_id: 'glofox:abc' }), hatch(), deps())).toMatchObject({ moved: false, error: 'class_unavailable' })
    expect(await un1tMoveBooking(ctxFor(db), minput({ starts_at: FROM_LABEL }), hatch(), deps())).toMatchObject({ moved: false, error: 'class_unavailable', reason: 'starts_at_mismatch' })
    expect(await un1tMoveBooking(ctxFor(db), minput({ booking_id: 'abc' }), hatch(), deps())).toMatchObject({ moved: false, error: 'MOVE_UNCERTAIN' })
    expect(h.moveBooking).not.toHaveBeenCalled()
  })

  it('not verified, or no account: nothing sent', async () => {
    const { db } = fakeDb()
    expect(await un1tMoveBooking(ctxFor(db, { verifiedContactId: null }), minput(), hatch(), deps())).toMatchObject({ error: 'not_verified' })
    expect(await un1tMoveBooking(ctxFor(db), minput(), hatch({ un1tUserId: null }), deps())).toMatchObject({ moved: false, not_linked: true })
    expect(h.moveBooking).not.toHaveBeenCalled()
  })
})
