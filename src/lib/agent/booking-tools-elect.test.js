// PERSON-ACCT.7 — book_class no longer books against whichever contact row
// the conversation happens to be attached to. It elects ONE account for the
// write (electWriteAccount, person-accounts.js), backed by the same
// upcoming-bookings fan-out list_my_upcoming_bookings uses, and escalates to
// a human rather than guessing when two accounts are genuinely live.
//
// The four invariants this file exists to hold:
//   1. the elected account is the one that receives the Glofox booking (and
//      the one every approval row is filed against + stamped with);
//   2. an event already booked on ANY linked account is never double-booked;
//   3. a conflict is LIVE-VERIFIED before it costs staff attention — a stale
//      CRM tie resolves itself silently;
//   4. a confirmed-empty elected account re-elects to a corroborated sibling
//      holding live credits before anyone is told "no credits".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  GLOFOX_BOOKING_MODEL: 'events',
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
  fetchUserCreditsResult: vi.fn(async () => ({ ok: true, credits: [] })),
  createBooking: vi.fn(async () => ({ ok: true, status: 200, body: { _id: 'gfb-1' } })),
}))
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import * as glofox from '@/lib/glofox'
import { notifyAgentApprovalRequest } from './approval-notify'
import { executeBookingTool } from './booking-tools'

const EVENT_ID = '64aa00000000000000000001'
const OTHER_EVENT_ID = '64aa00000000000000000009'
const nowSec = () => Math.floor(Date.now() / 1000)

// Same double as booking-tools-fanout.test.js, plus the insert's contact_id
// (which account the approval row is filed against is now load-bearing).
function stubDb(trace, { contacts = [], groupId = 'g-1', pendingRows = [] } = {}) {
  return {
    from(table) {
      const st = { table, cols: '', filters: {}, op: null }
      const settle = (single) => {
        if (table === 'person_group_members') {
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
        if (table === 'agent_membership_requests') {
          if (st.op === 'insert') return { data: { id: 'req-1' }, error: null }
          return { data: single ? null : pendingRows, error: null }
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
          trace.push({ step: 'insert', table, status: row.status, contactId: row.contact_id, details: row.details })
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

const ctx = (db, settings = { booking_mode: 'auto' }) => ({
  db,
  conversationId: 'conv-1',
  conversationsTable: 'whatsapp_conversations',
  contactId: 'c-1',
  verifiedContactId: 'c-1',
  locationId: 'loc-1',
  channel: 'whatsapp',
  nameHint: 'Vanessa',
  settings,
})

// Every fixture shares a phone, so `corroborated` holds across the group.
const PHONE = '+353871234567'
const acct = (id, memberId, extra = {}) => ({
  id,
  name: `Vanessa ${id}`,
  glofox_member_id: memberId,
  glofox_membership_status: 'lead',
  glofox_membership_state: null,
  trial_credits_remaining: null,
  last_attended_at: null,
  updated_at: '2026-08-01T00:00:00Z',
  phone: PHONE,
  wa_phone: null,
  email: null,
  ...extra,
})

const creditsByMember = (map) => {
  glofox.fetchUserCreditsResult.mockImplementation(async (_creds, memberId) =>
    map[memberId] || { ok: true, credits: [] })
}
const bookingsByMember = (map) => {
  glofox.fetchUserBookingsResult.mockImplementation(async (_creds, memberId) =>
    map[memberId] || { ok: true, bookings: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  glofox.glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't' })
  glofox.missingGlofoxCredentialsForLocation.mockReturnValue([])
  glofox.fetchUserBookingsResult.mockResolvedValue({ ok: true, bookings: [] })
  glofox.fetchUserCreditsResult.mockResolvedValue({ ok: true, credits: [] })
  glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { _id: 'gfb-1' } })
})

describe('book_class elects the write account', () => {
  // The whole point: the conversation is attached to c-1 (a bare lead row),
  // the membership lives on the sibling. Booking gf-1 fails in Glofox; the
  // election books gf-2.
  it('books against the ELECTED sibling, not the anchor the conversation hangs off', async () => {
    const group = [
      acct('c-1', 'gf-1'),
      acct('c-2', 'gf-2', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
    ]
    const trace = []
    const res = await executeBookingTool('book_class',
      { event_id: EVENT_ID, class_name: 'ARENA', class_time: 'Mon 06:15' }, ctx(stubDb(trace, { contacts: group })))

    expect(res).toMatchObject({ booked: true })
    expect(glofox.createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gf-2' }))
    // The audit row follows the election: filed against the elected account's
    // contact (so the executor re-runs it against the right account) and
    // stamped with the member id the write actually used.
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert.contactId).toBe('c-2')
    expect(insert.details.elected_glofox_member_id).toBe('gf-2')
    expect(trace.at(-1)).toMatchObject({ step: 'update', status: 'actioned' })
  })

  it('a lone ungrouped account still books exactly as before (election is a no-op)', async () => {
    const trace = []
    const solo = [acct('c-1', 'gf-1', { glofox_membership_status: 'member', glofox_membership_state: 'active' })]
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: solo })))

    expect(res).toMatchObject({ booked: true })
    expect(glofox.createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gf-1' }))
    expect(trace.find((t) => t.step === 'insert').contactId).toBe('c-1')
  })

  // MIA-REVIEW.3's audit invariant, extended: every booking-shaped row this
  // tool files names the account the booking runs (or would run) against.
  it('stamps elected_glofox_member_id on the no_credits approval row too', async () => {
    const group = [acct('c-1', 'gf-1'), acct('c-2', 'gf-2')]
    creditsByMember({}) // every account confirmed empty
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: group })))

    expect(res).toMatchObject({ booked: false, no_credits: true })
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert.details).toMatchObject({ reason: 'no_credits' })
    expect(insert.details.elected_glofox_member_id).toBeTruthy()
    expect(glofox.createBooking).not.toHaveBeenCalled()
  })

  it('stamps elected_glofox_member_id on a DRAFT-mode row', async () => {
    const group = [
      acct('c-1', 'gf-1'),
      acct('c-2', 'gf-2', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
    ]
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID },
      ctx(stubDb(trace, { contacts: group }), { booking_mode: 'draft' }))

    expect(res).toMatchObject({ requested: true })
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert.details.elected_glofox_member_id).toBe('gf-2')
    expect(insert.contactId).toBe('c-2')
    expect(glofox.createBooking).not.toHaveBeenCalled()
  })
})

describe('cross-account double-booking backstop', () => {
  it('the event is already booked on a SIBLING account → already-booked success, no second booking', async () => {
    const group = [
      acct('c-1', 'gf-1', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
      acct('c-2', 'gf-2', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
    ]
    bookingsByMember({
      'gf-2': { ok: true, bookings: [{ _id: '64bb00000000000000000001', model_id: EVENT_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
    })
    const trace = []
    const res = await executeBookingTool('book_class',
      { event_id: EVENT_ID, class_name: 'ARENA', class_time: 'Mon 06:15' }, ctx(stubDb(trace, { contacts: group })))

    // Byte-for-byte the shape interpretBookingResult's alreadyBooked path
    // already answers with — the member IS in the class.
    expect(res).toEqual({ booked: true, class_name: 'ARENA', class_time: 'Mon 06:15' })
    expect(glofox.createBooking).not.toHaveBeenCalled()
    expect(trace.filter((t) => t.step === 'insert')).toHaveLength(0)
  })

  it('a CANCELLED booking for that event is not "already booked" — the booking proceeds', async () => {
    const group = [acct('c-1', 'gf-1', { glofox_membership_status: 'member', glofox_membership_state: 'active' })]
    bookingsByMember({
      'gf-1': { ok: true, bookings: [{ _id: '64bb00000000000000000001', model_id: EVENT_ID, status: 'CANCELLED', time_start: nowSec() + 3600 }] },
    })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb([], { contacts: group })))

    expect(res).toMatchObject({ booked: true })
    expect(glofox.createBooking).toHaveBeenCalled()
  })

  it('a booking for a DIFFERENT event never blocks this one', async () => {
    const group = [acct('c-1', 'gf-1', { glofox_membership_status: 'member', glofox_membership_state: 'active' })]
    bookingsByMember({
      'gf-1': { ok: true, bookings: [{ _id: '64bb00000000000000000001', model_id: OTHER_EVENT_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
    })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb([], { contacts: group })))

    expect(res).toMatchObject({ booked: true })
    expect(glofox.createBooking).toHaveBeenCalled()
  })

  // The fan-out doubles as the election's activity signal: the account
  // holding this person's upcoming bookings wins over a bare entitlement
  // elsewhere (electWriteAccount rule 2), so their history stops fragmenting.
  it('the account holding upcoming bookings is elected over an equally-ranked sibling', async () => {
    const group = [
      acct('c-1', 'gf-1', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
      acct('c-2', 'gf-2', { glofox_membership_status: 'member', glofox_membership_state: 'active' }),
    ]
    bookingsByMember({
      'gf-2': { ok: true, bookings: [{ _id: '64bb00000000000000000002', model_id: OTHER_EVENT_ID, status: 'BOOKED', time_start: nowSec() + 3600 }] },
    })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb([], { contacts: group })))

    expect(res).toMatchObject({ booked: true })
    expect(glofox.createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gf-2' }))
  })
})

describe('a genuine conflict escalates to a human', () => {
  const TIED_MEMBERS = [
    acct('c-1', 'gf-1', { glofox_membership_status: 'member', glofox_membership_state: 'active', last_attended_at: '2026-08-01T10:00:00Z' }),
    acct('c-2', 'gf-2', { glofox_membership_status: 'member', glofox_membership_state: 'active', last_attended_at: '2026-08-20T10:00:00Z' }),
  ]

  it('two live-confirmed accounts → pending account_conflict row with the candidates, and the flag', async () => {
    creditsByMember({
      'gf-1': { ok: true, credits: [{ active: true, available: 3 }] },
      'gf-2': { ok: true, credits: [{ active: true, available: 1 }] },
    })
    const trace = []
    const res = await executeBookingTool('book_class',
      { event_id: EVENT_ID, class_name: 'ARENA' }, ctx(stubDb(trace, { contacts: TIED_MEMBERS })))

    expect(res).toMatchObject({ account_conflict: true, booked: false })
    expect(glofox.createBooking).not.toHaveBeenCalled()

    const insert = trace.find((t) => t.step === 'insert')
    expect(insert).toMatchObject({ table: 'agent_membership_requests', status: 'pending' })
    // Filed against the TOP candidate (most recent activity wins the tie),
    // and stamped with that account — so approving books the right one.
    expect(insert.contactId).toBe('c-2')
    expect(insert.details.elected_glofox_member_id).toBe('gf-2')
    expect(insert.details.reason).toBe('account_conflict')
    // The machine reason stays a bare code; the ambiguity is structured data.
    expect(insert.details.reason).not.toMatch(/gf-/)
    expect(insert.details.candidates).toHaveLength(2)
    expect(insert.details.candidates[0]).toMatchObject({
      contact_id: 'c-2', glofox_member_id: 'gf-2', membership_status: 'member', credits: 1,
    })
    expect(insert.details.candidates[1]).toMatchObject({ contact_id: 'c-1', glofox_member_id: 'gf-1', credits: 3 })
    expect(notifyAgentApprovalRequest).toHaveBeenCalledOnce()
  })

  it('a retried tool call reuses the existing pending card — staff are not double-carded', async () => {
    creditsByMember({
      'gf-1': { ok: true, credits: [{ active: true, available: 3 }] },
      'gf-2': { ok: true, credits: [{ active: true, available: 1 }] },
    })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID },
      ctx(stubDb(trace, { contacts: TIED_MEMBERS, pendingRows: [{ id: 'existing-1' }] })))

    expect(res).toMatchObject({ account_conflict: true })
    expect(trace.filter((t) => t.step === 'insert')).toHaveLength(0)
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  // A CRM tie is not evidence of a live tie. Two rows both look credit-holding
  // in the CRM, but only one still holds credits in Glofox — escalating that
  // would spend a human on a question that answers itself.
  it('live-verify DEMOTES a stale conflict: only one candidate verifies → elected, no card', async () => {
    const stale = [
      acct('c-1', 'gf-1', { trial_credits_remaining: 4, last_attended_at: '2026-08-20T10:00:00Z' }),
      acct('c-2', 'gf-2', { trial_credits_remaining: 2, last_attended_at: '2026-08-01T10:00:00Z' }),
    ]
    creditsByMember({
      'gf-1': { ok: true, credits: [{ active: true, available: 4 }] },
      'gf-2': { ok: true, credits: [] }, // the CRM is stale — nothing left here
    })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: stale })))

    expect(res.account_conflict).toBeUndefined()
    expect(res).toMatchObject({ booked: true })
    expect(glofox.createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gf-1' }))
    expect(trace.some((t) => t.details?.reason === 'account_conflict')).toBe(false)
    expect(notifyAgentApprovalRequest).not.toHaveBeenCalled()
  })

  it('an UNREADABLE candidate is not a live conflict either — the readable one is elected', async () => {
    const tied = [
      acct('c-1', 'gf-1', { trial_credits_remaining: 4 }),
      acct('c-2', 'gf-2', { trial_credits_remaining: 2 }),
    ]
    creditsByMember({
      'gf-1': { ok: false, credits: [] },
      'gf-2': { ok: true, credits: [{ active: true, available: 2 }] },
    })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: tied })))

    expect(res.account_conflict).toBeUndefined()
    expect(glofox.createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gf-2' }))
  })

  // Nothing verified at all (both reads down): a broken pre-check must never
  // block a booking that would have worked — Glofox still arbitrates.
  it('no candidate verifies → the top-ranked account proceeds, no escalation', async () => {
    creditsByMember({ 'gf-1': { ok: false, credits: [] }, 'gf-2': { ok: false, credits: [] } })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: TIED_MEMBERS })))

    expect(res.account_conflict).toBeUndefined()
    expect(glofox.createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gf-2' }))
  })
})

describe('sibling re-election before no_credits', () => {
  it('the elected account is confirmed empty but a corroborated sibling holds live credits → re-elect and book', async () => {
    const group = [
      acct('c-1', 'gf-1', { last_attended_at: '2026-08-25T10:00:00Z' }), // ranks first: most recent
      acct('c-2', 'gf-2', { last_attended_at: '2026-08-01T10:00:00Z' }),
    ]
    creditsByMember({
      'gf-1': { ok: true, credits: [] },
      'gf-2': { ok: true, credits: [{ active: true, available: 2 }] },
    })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: group })))

    expect(res).toMatchObject({ booked: true })
    expect(res.no_credits).toBeUndefined()
    expect(glofox.createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gf-2' }))
    const insert = trace.find((t) => t.step === 'insert')
    expect(insert.details.elected_glofox_member_id).toBe('gf-2')
    expect(insert.contactId).toBe('c-2')
  })

  it('a CLASSPASS sibling with credits is never re-elected to — no_credits still escalates', async () => {
    const group = [
      acct('c-1', 'gf-1', { last_attended_at: '2026-08-25T10:00:00Z' }),
      acct('c-2', 'gf-2', { glofox_membership_status: 'classpass_payg' }),
    ]
    creditsByMember({
      'gf-1': { ok: true, credits: [] },
      'gf-2': { ok: true, credits: [{ active: true, available: 5 }] },
    })
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: group })))

    expect(res).toMatchObject({ no_credits: true })
    expect(glofox.createBooking).not.toHaveBeenCalled()
  })

  it('an UNCORROBORATED sibling with credits is never re-elected to (it may be a stranger)', async () => {
    const group = [
      acct('c-1', 'gf-1', { last_attended_at: '2026-08-25T10:00:00Z' }),
      { ...acct('c-3', 'gf-3'), phone: '+353899999999', email: 'stranger@example.com' },
    ]
    creditsByMember({
      'gf-1': { ok: true, credits: [] },
      'gf-3': { ok: true, credits: [{ active: true, available: 5 }] },
    })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb([], { contacts: group })))

    expect(res).toMatchObject({ no_credits: true })
    expect(glofox.createBooking).not.toHaveBeenCalled()
  })

  it('no sibling has anything either → the unchanged no_credits escalation', async () => {
    const group = [acct('c-1', 'gf-1'), acct('c-2', 'gf-2')]
    creditsByMember({})
    const trace = []
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(stubDb(trace, { contacts: group })))

    expect(res).toMatchObject({ booked: false, no_credits: true })
    expect(res.message).toMatch(/no class credits/i)
    expect(trace.find((t) => t.step === 'insert').details.reason).toBe('no_credits')
  })
})
