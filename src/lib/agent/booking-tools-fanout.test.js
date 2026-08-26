// PERSON-ACCT.2 — one person routinely holds 2-3 `contacts` rows, each
// linked to a DIFFERENT Glofox account, so the account a WhatsApp
// conversation happens to be attached to is often NOT the account the
// booking lives on. Before this task `list_my_upcoming_bookings` read the
// acting contact's account only and told real customers "you have no
// bookings", and `cancel_class_booking` cancelled against that same account
// (i.e. against the wrong one).
//
// The two invariants these tests exist to hold:
//   1. reads fan out across EVERY linked account, and
//   2. an UNREADABLE account never becomes a customer-facing "you have
//      nothing" / "that booking does not exist".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  GLOFOX_BOOKING_MODEL: 'events',
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUserBookingsResult: vi.fn(),
  cancelBooking: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import * as glofox from '@/lib/glofox'
import { executeBookingTool } from './booking-tools'

const BOOKING_ID = '64bb00000000000000000001'
const OTHER_BOOKING_ID = '64bb00000000000000000002'

const nowSec = () => Math.floor(Date.now() / 1000)

// A person group: the anchor (c-1 / gf-1) plus siblings. `contacts` rows carry
// the columns person-accounts.js selects; the double answers the three reads
// linkedAccountsForContact makes (membership → members → contacts) plus the
// tool's own contact re-read and the agent_membership_requests audit writes.
function stubDb(trace, { contacts = [], groupId = 'g-1', groupReadError = null } = {}) {
  return {
    from(table) {
      const st = { table, cols: '', filters: {}, op: null }
      const settle = (single) => {
        if (table === 'person_group_members') {
          if (groupReadError) return { data: null, error: groupReadError }
          if (st.cols.includes('group_id')) return { data: { group_id: groupId }, error: null }
          return { data: contacts.map((c) => ({ contact_id: c.id })), error: null }
        }
        if (table === 'contacts') {
          const want = st.filters.id
          const list = Array.isArray(want)
            ? contacts.filter((c) => want.includes(c.id))
            : contacts.filter((c) => c.id === want)
          return single ? { data: list[0] || null, error: null } : { data: list, error: null }
        }
        if (table === 'agent_membership_requests' && st.op === 'insert') {
          return { data: { id: 'req-1' }, error: null }
        }
        return { data: single ? null : [], error: null }
      }
      const b = {
        select(cols) { st.cols = cols || ''; return b },
        eq(col, val) { st.filters[col] = val; return b },
        in(col, vals) { st.filters[col] = vals; return b },
        contains: () => b,
        limit: () => b,
        order: () => b,
        insert(row) {
          st.op = 'insert'
          trace.push({ step: 'insert', table, status: row.status, details: row.details })
          return b
        },
        update(patch) {
          st.op = 'update'
          trace.push({ step: 'update', table, status: patch.status, details: patch.details })
          return b
        },
        async maybeSingle() { return settle(true) },
        async single() { return settle(true) },
        then(resolve, reject) { return Promise.resolve(settle(false)).then(resolve, reject) },
      }
      return b
    },
  }
}

const ctx = (db) => ({
  db,
  conversationId: 'conv-1',
  conversationsTable: 'whatsapp_conversations',
  contactId: 'c-1',
  verifiedContactId: 'c-1',
  locationId: 'loc-1',
  channel: 'whatsapp',
  nameHint: 'Vanessa',
  settings: { booking_mode: 'auto' },
})

// Two contacts, same human: same phone (so `corroborated` holds), two accounts.
const TWIN_GROUP = [
  { id: 'c-1', name: 'Vanessa D', glofox_member_id: 'gf-1', glofox_membership_status: 'member', phone: '+353871234567', wa_phone: '353871234567', email: 'v@example.com' },
  { id: 'c-2', name: 'Vanessa Doyle', glofox_member_id: 'gf-2', glofox_membership_status: 'member', phone: '087 123 4567', wa_phone: null, email: null },
]

// Route the fan-out per member id.
function bookingsByMember(map) {
  glofox.fetchUserBookingsResult.mockImplementation(async (_creds, memberId) => {
    const entry = map[memberId]
    if (!entry) return { ok: true, bookings: [] }
    return entry
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  glofox.glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't' })
  glofox.missingGlofoxCredentialsForLocation.mockReturnValue([])
  glofox.cancelBooking.mockResolvedValue({ ok: true, status: 200, body: {} })
})

describe('list_my_upcoming_bookings fans out across every linked account', () => {
  it('merges both accounts, sorted by start time, deduped, rows carrying no account id', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [
        { _id: BOOKING_ID, status: 'BOOKED', event_name: 'ARENA', time_start: nowSec() + 7200 },
      ] },
      'gf-2': { ok: true, bookings: [
        { _id: OTHER_BOOKING_ID, status: 'BOOKED', event_name: 'SQUAD', time_start: nowSec() + 3600 },
        // The same booking visible on both accounts must appear once.
        { _id: BOOKING_ID, status: 'BOOKED', event_name: 'ARENA', time_start: nowSec() + 7200 },
      ] },
    })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))

    expect(glofox.fetchUserBookingsResult).toHaveBeenCalledTimes(2)
    expect(res.incomplete).toBeUndefined()
    expect(res.bookings.map((b) => b.booking_id)).toEqual([OTHER_BOOKING_ID, BOOKING_ID])
    expect(res.bookings[0].class_name).toBe('SQUAD')
  })

  // The whole tool result is stringified into the model's context, so the
  // rows must not carry internal Glofox account ids. cancel_class_booking
  // re-locates ownership server-side and never reads them back.
  it('returned rows carry NO account id — same shape as the single-account tool', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', event_name: 'ARENA', time_start: nowSec() + 7200 }] },
      'gf-2': { ok: true, bookings: [{ _id: OTHER_BOOKING_ID, status: 'BOOKED', event_name: 'SQUAD', time_start: nowSec() + 3600 }] },
    })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))

    for (const row of res.bookings) {
      expect(row).not.toHaveProperty('_member')
      expect(Object.keys(row).sort()).toEqual(['booking_id', 'class_name', 'time'])
      expect(JSON.stringify(row)).not.toMatch(/gf-\d/)
    }
  })

  // The merge sorts on the numeric start, which the shaper strips — an
  // idless row must still land in time order, not at one end of the list.
  it('a row Glofox returned without an id still sorts by its start time', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [
        { status: 'BOOKED', event_name: 'LATE', time_start: nowSec() + 10800 },
      ] },
      'gf-2': { ok: true, bookings: [
        { _id: OTHER_BOOKING_ID, status: 'BOOKED', event_name: 'EARLY', time_start: nowSec() + 3600 },
      ] },
    })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))
    expect(res.bookings.map((b) => b.class_name)).toEqual(['EARLY', 'LATE'])
  })

  it('one account unreadable + bookings on the other → returns them with incomplete:true', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [
        { _id: BOOKING_ID, status: 'BOOKED', event_name: 'ARENA', time_start: nowSec() + 7200 },
      ] },
      'gf-2': { ok: false, bookings: [] },
    })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))

    expect(res.bookings).toHaveLength(1)
    expect(res.incomplete).toBe(true)
    expect(res.message).toMatch(/missing/i)
    expect(res.error).toBeUndefined()
  })

  // The lane that actually shipped the live incident: the account we COULD
  // read is genuinely empty and the one holding the booking is down. An empty
  // list — with or without incomplete:true — is the false negative. Deleting
  // the `failedReads > 0 && bookings.length === 0` guard leaves every other
  // test in this file green and reintroduces it.
  it('one account readable-and-EMPTY + one unreadable → list_failed, NOT an empty incomplete list', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [] },
      'gf-2': { ok: false, bookings: [] },
    })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))

    expect(res).toEqual({ error: 'list_failed', message: 'Could not load their bookings just now — offer to hand off.' })
    expect(res.bookings).toBeUndefined()
    expect(res.incomplete).toBeUndefined()
  })

  it('EVERY account unreadable → list_failed, never an empty "no bookings" answer', async () => {
    bookingsByMember({ 'gf-1': { ok: false, bookings: [] }, 'gf-2': { ok: false, bookings: [] } })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))

    expect(res).toEqual({ error: 'list_failed', message: 'Could not load their bookings just now — offer to hand off.' })
    expect(res.bookings).toBeUndefined()
  })

  it('a thrown read counts as unreadable too (allSettled), never as empty', async () => {
    glofox.fetchUserBookingsResult.mockRejectedValue(new Error('network'))
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))
    expect(res.error).toBe('list_failed')
  })

  it('readFailed from linkedAccountsForContact → single-account fallback still lists that account', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    bookingsByMember({
      'gf-1': { ok: true, bookings: [
        { _id: BOOKING_ID, status: 'BOOKED', event_name: 'ARENA', time_start: nowSec() + 7200 },
      ] },
    })
    const db = stubDb([], { contacts: TWIN_GROUP, groupReadError: { message: 'group lookup down' } })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(db))

    expect(glofox.fetchUserBookingsResult).toHaveBeenCalledTimes(1)
    expect(glofox.fetchUserBookingsResult).toHaveBeenCalledWith(
      expect.anything(), 'gf-1', { windowDays: 0, limit: 100 },
    )
    expect(res.bookings.map((b) => b.booking_id)).toEqual([BOOKING_ID])
    // Behaviourally identical to the pre-PERSON-ACCT.2 lane: same row shape,
    // no account id smuggled in by the shared merge.
    expect(res.bookings[0]).not.toHaveProperty('_member')
    expect(Object.keys(res.bookings[0]).sort()).toEqual(['booking_id', 'class_name', 'time'])
    err.mockRestore()
  })

  it('all accounts readable and empty → the unchanged none-found answer', async () => {
    bookingsByMember({})
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))
    expect(res).toEqual({ bookings: [], message: 'No upcoming bookings found for this member.' })
  })

  // The merge must sort on the numeric instant, never on the Dublin label:
  // "Mon 31 Aug" sorts BEFORE "Sun 30 Aug" lexicographically, so a label sort
  // would hand the customer next Monday's class as their next one.
  it('sorts across a weekday boundary — Sunday before Monday, not alphabetically', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T11:00:00Z')) // Fri 28 Aug 2026, 12:00 Dublin
    try {
      const SUN = Math.floor(new Date('2026-08-30T07:00:00+01:00').getTime() / 1000)
      const MON = Math.floor(new Date('2026-08-31T07:00:00+01:00').getTime() / 1000)
      bookingsByMember({
        'gf-1': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', event_name: 'MONDAY', time_start: MON }] },
        'gf-2': { ok: true, bookings: [{ _id: OTHER_BOOKING_ID, status: 'BOOKED', event_name: 'SUNDAY', time_start: SUN }] },
      })
      const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))

      expect(res.bookings.map((b) => b.class_name)).toEqual(['SUNDAY', 'MONDAY'])
      expect(res.bookings.map((b) => b.time)).toEqual(['Sun 30 Aug, 07:00', 'Mon 31 Aug, 07:00'])
      // The label the sort must NOT be keyed on: alphabetically inverted.
      expect(res.bookings[1].time < res.bookings[0].time).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Dedupe must run BEFORE the cap, or a booking visible on two accounts
  // burns a slot and silently drops the last real class off the list.
  it('caps at 10 AFTER deduping — a cross-account duplicate consumes no slot', async () => {
    const id = (n) => `64bb0000000000000000${String(n).padStart(4, '0')}`
    const mk = (n) => ({ _id: id(n), status: 'BOOKED', event_name: `C${n}`, time_start: nowSec() + n * 3600 })
    bookingsByMember({
      // 10 unique on the anchor, and on the sibling a DUPLICATE of C5 plus one
      // later class — 11 unique in all, against a cap of 10.
      'gf-1': { ok: true, bookings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(mk) },
      'gf-2': { ok: true, bookings: [mk(5), mk(11)] },
    })
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: TWIN_GROUP })))

    expect(res.bookings).toHaveLength(10)
    // C10 survives — had the duplicate taken a slot it would have been cut.
    expect(res.bookings.map((b) => b.class_name)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `C${n}`),
    )
    expect(res.bookings.filter((b) => b.booking_id === id(5))).toHaveLength(1)
  })

  // The two zero-account lanes answer DIFFERENTLY on purpose: rows we read
  // prove nobody is linked; no rows at all prove nothing.
  it('contacts present but not one carries a Glofox link → not_linked', async () => {
    const unlinked = [{ id: 'c-1', name: 'Vanessa D', glofox_member_id: null, phone: '+353871234567', wa_phone: null, email: 'v@example.com' }]
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: unlinked })))

    expect(res).toEqual({ error: 'not_linked', message: 'This member is not linked to the studio booking system — hand off to the team.' })
    expect(glofox.fetchUserBookingsResult).not.toHaveBeenCalled()
  })

  it('no contacts rows came back at all → list_failed, never not_linked', async () => {
    const res = await executeBookingTool('list_my_upcoming_bookings', {}, ctx(stubDb([], { contacts: [] })))

    expect(res).toEqual({ error: 'list_failed', message: 'Could not load their bookings just now — offer to hand off.' })
    expect(glofox.fetchUserBookingsResult).not.toHaveBeenCalled()
  })
})

describe('cancel_class_booking locates the booking\'s true owner', () => {
  it('booking owned by a CORROBORATED sibling → cancels against the SIBLING account, audit names it', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [] },
      'gf-2': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
    })
    const trace = []
    const res = await executeBookingTool('cancel_class_booking',
      { booking_id: BOOKING_ID, class_name: 'SQUAD' }, ctx(stubDb(trace, { contacts: TWIN_GROUP })))

    expect(res).toMatchObject({ cancelled: true })
    expect(glofox.cancelBooking).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, 'gf-2')
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert.details).toMatchObject({ executing_contact_id: 'c-2', executing_glofox_member_id: 'gf-2' })
    expect(trace.at(-1)).toMatchObject({ step: 'update', status: 'actioned' })
  })

  it('booking on the anchor\'s OWN account → unchanged single-account cancel', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
      'gf-2': { ok: true, bookings: [] },
    })
    const trace = []
    const res = await executeBookingTool('cancel_class_booking',
      { booking_id: BOOKING_ID }, ctx(stubDb(trace, { contacts: TWIN_GROUP })))

    expect(res).toMatchObject({ cancelled: true })
    expect(glofox.cancelBooking).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, 'gf-1')
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert.details.executing_contact_id).toBeUndefined()
  })

  it('owner is a classpass_payg sibling → needs_staff, no Glofox cancel', async () => {
    const group = [
      TWIN_GROUP[0],
      { ...TWIN_GROUP[1], glofox_membership_status: 'classpass_payg' },
    ]
    bookingsByMember({
      'gf-1': { ok: true, bookings: [] },
      'gf-2': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
    })
    const trace = []
    const res = await executeBookingTool('cancel_class_booking',
      { booking_id: BOOKING_ID }, ctx(stubDb(trace, { contacts: group })))

    expect(res).toMatchObject({ cancelled: false, needs_staff: true })
    expect(res.message).toMatch(/team will sort the cancellation/i)
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
    expect(trace.filter((t) => t.step === 'insert')).toHaveLength(0)
  })

  it('owner sibling shares NO phone or email (uncorroborated) → needs_staff, no Glofox cancel', async () => {
    const group = [
      TWIN_GROUP[0],
      { id: 'c-3', name: 'Someone Else', glofox_member_id: 'gf-3', glofox_membership_status: 'member', phone: '+353899999999', wa_phone: null, email: 'other@example.com' },
    ]
    bookingsByMember({
      'gf-1': { ok: true, bookings: [] },
      'gf-3': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
    })
    const trace = []
    const res = await executeBookingTool('cancel_class_booking',
      { booking_id: BOOKING_ID }, ctx(stubDb(trace, { contacts: group })))

    expect(res).toMatchObject({ cancelled: false, needs_staff: true })
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
  })

  it('not found anywhere + an UNREADABLE account → uncertainty, never "does not exist", no cancel', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [] },
      'gf-2': { ok: false, bookings: [] },
    })
    const trace = []
    const res = await executeBookingTool('cancel_class_booking',
      { booking_id: BOOKING_ID }, ctx(stubDb(trace, { contacts: TWIN_GROUP })))

    expect(res.cancelled).toBe(false)
    expect(res.message).toMatch(/could not check/i)
    expect(res.message).toMatch(/hand off/i)
    // The model is told NOT to claim absence — the phrase may only appear
    // under a prohibition, never as the answer to relay.
    expect(res.message).toMatch(/do NOT say the booking does not exist/i)
    expect(res.message).not.toMatch(/(?<!not say )the booking (does not exist|was not found)\.?$/i)
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
    expect(trace.filter((t) => t.step === 'insert')).toHaveLength(0)
  })

  it('not found anywhere with EVERY account readable → Glofox still arbitrates (unchanged behaviour)', async () => {
    bookingsByMember({ 'gf-1': { ok: true, bookings: [] }, 'gf-2': { ok: true, bookings: [] } })
    glofox.cancelBooking.mockResolvedValue({ ok: false, status: 404, body: { message_code: 'BOOKING_NOT_FOUND' } })
    const trace = []
    const res = await executeBookingTool('cancel_class_booking',
      { booking_id: BOOKING_ID }, ctx(stubDb(trace, { contacts: TWIN_GROUP })))

    expect(glofox.cancelBooking).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, 'gf-1')
    expect(res).toMatchObject({ cancelled: false, reason: 'BOOKING_NOT_FOUND' })
  })

  // DRAFT mode queues a class_cancellation the approval executor later runs
  // against row.contact_id's account. Until that executor honours an
  // executing_contact_id override (PR2), a sibling-owned draft would execute
  // against the WRONG account — so no sibling qualifies for a draft at all,
  // corroborated or not.
  it('draft mode + sibling owner → needs_staff and NO draft row', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [] },
      'gf-2': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
    })
    const trace = []
    const c = ctx(stubDb(trace, { contacts: TWIN_GROUP }))
    c.settings = { booking_mode: 'draft' }
    const res = await executeBookingTool('cancel_class_booking', { booking_id: BOOKING_ID }, c)

    expect(res).toMatchObject({ cancelled: false, needs_staff: true })
    expect(res.requested).toBeUndefined()
    expect(trace.filter((t) => t.step === 'insert')).toHaveLength(0)
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
  })

  it('draft mode + anchor owner → the draft row is queued exactly as before', async () => {
    bookingsByMember({
      'gf-1': { ok: true, bookings: [{ _id: BOOKING_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
      'gf-2': { ok: true, bookings: [] },
    })
    const trace = []
    const c = ctx(stubDb(trace, { contacts: TWIN_GROUP }))
    c.settings = { booking_mode: 'draft' }
    const res = await executeBookingTool('cancel_class_booking', { booking_id: BOOKING_ID, class_name: 'ARENA' }, c)

    expect(res).toMatchObject({ requested: true })
    expect(res.message).toMatch(/Queued for the team to confirm/)
    // Ownership WAS checked before drafting — it just landed on the anchor.
    expect(glofox.fetchUserBookingsResult).toHaveBeenCalled()
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert).toMatchObject({ table: 'agent_membership_requests', status: 'pending' })
    expect(insert.details).toMatchObject({ booking_id: BOOKING_ID, mode: 'draft' })
    expect(insert.details.stage).toBeUndefined()
    expect(glofox.cancelBooking).not.toHaveBeenCalled()
  })

  it('draft mode with no Glofox credentials still drafts (no owner lookup possible)', async () => {
    glofox.missingGlofoxCredentialsForLocation.mockReturnValue(['apiKey'])
    const trace = []
    const c = ctx(stubDb(trace, { contacts: TWIN_GROUP }))
    c.settings = { booking_mode: 'draft' }
    const res = await executeBookingTool('cancel_class_booking', { booking_id: BOOKING_ID }, c)

    expect(res).toMatchObject({ requested: true })
    expect(glofox.fetchUserBookingsResult).not.toHaveBeenCalled()
    expect(trace.filter((t) => t.step === 'insert')).toHaveLength(1)
  })

  it('readFailed from linkedAccountsForContact → single-account cancel, unchanged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = []
    const db = stubDb(trace, { contacts: TWIN_GROUP, groupReadError: { message: 'group lookup down' } })
    const res = await executeBookingTool('cancel_class_booking', { booking_id: BOOKING_ID }, ctx(db))

    expect(res).toMatchObject({ cancelled: true })
    expect(glofox.fetchUserBookingsResult).not.toHaveBeenCalled()
    expect(glofox.cancelBooking).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, 'gf-1')
    err.mockRestore()
  })
})
