// PERSON-ACCT.9 — the /start funnel judges the PERSON, not the one contacts
// row the public form happened to create.
//
// The bug this file exists for: a returner fills the form with a NEW email,
// becomes a NEW contact with no glofox_member_id, and every "is this a
// returner?" check downstream sees a blank slate — so the processor MINTED a
// second Glofox account and granted a second free trial. 879 of 887 person
// groups in prod are divergent; this closes one source.
//
// The invariants held here:
//   1. a REUSABLE sibling's account is reused, never re-minted — reusable
//      meaning a vetted person_group member or an exact email match;
//   2. a PHONE-ONLY sibling is never written to. Couples share numbers (62
//      live phone-groups at Stillorgan carry different first names, 59 of
//      them holding multiple Glofox accounts), and core.js's resolveAutoVerify
//      already refuses the same couple case. It blocks the mint and goes to
//      review instead — the conservative half, never the write;
//   3. a sibling we cannot corroborate at all (a name-ish group match) blocks
//      the mint too;
//   4. attendance is judged across the whole person — deliberately WIDER than
//      the write side, because withholding a free class costs a review, not a
//      wrong charge;
//   5. the balance is judged across the person's REUSABLE accounts only, and
//      the booking runs against the account that actually holds it;
//   6. a GENUINELY new person still mints + grants + books, unchanged;
//   7. the approval dedupe matches person-wide, on the same reuse rule.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(async () => ({ ok: true, status: 200, body: { _id: 'gfb-1' } })),
  fetchUserCredits: vi.fn(async () => [{ active: true, available: 3 }]),
  fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
  GLOFOX_BOOKING_MODEL: 'event',
}))
vi.mock('@/lib/glofox-sync', () => ({ computeCreditsRemaining: vi.fn(() => 3) }))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'created', glofox_member_id: 'gm-new' })) }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: vi.fn(async () => ({ sent: true })), CLASS_CONFIRM_TEMPLATE: 'booking_class_confirmed_' }))

import { processClassBookingRequest } from './class-booking-processor'
import { createBooking, fetchUserCredits, fetchUserBookingsResult } from '@/lib/glofox'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { computeCreditsRemaining } from '@/lib/glofox-sync'

const LOC = 'loc-1'
const PHONE = '+353871234567'
const req = {
  id: 'r1', location_id: LOC, contact_id: 'c-new', glofox_event_id: 'e1',
  class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z',
}

// The funnel row: brand-new, no Glofox link, a NEW email, the SAME phone.
const funnelContact = (extra = {}) => ({
  id: 'c-new',
  first_name: 'Sam', last_name: 'Lee', name: 'Sam Lee',
  email: 'sam.new@example.com',
  phone: PHONE, wa_phone: null,
  glofox_member_id: null,
  glofox_membership_status: null, glofox_membership_state: null,
  trial_credits_remaining: null,
  last_attended_at: null,
  updated_at: '2026-08-01T00:00:00Z',
  location_id: LOC,
  ctwa_clid: null,
  ...extra,
})

// A sibling sharing ONLY the phone — indistinguishable, from the row alone,
// from the anchor's partner. Findable by the direct search, never writable.
const sibling = (id, extra = {}) => ({
  id,
  name: 'Sam Lee',
  glofox_member_id: null,
  glofox_membership_status: 'lead', glofox_membership_state: null,
  trial_credits_remaining: null,
  last_attended_at: null,
  updated_at: '2026-07-01T00:00:00Z',
  phone: PHONE, wa_phone: null,
  email: 'sam.old@example.com',
  location_id: LOC,
  ...extra,
})

// The two shapes a WRITE may move onto:
//  • grouped — person-detect (or a human) vetted the link, so a shared phone
//    is enough on top of it;
//  • same email — contacts_email_unique is global and case-SENSITIVE (mig
//    008, `ON contacts (email) WHERE email IS NOT NULL`), so two rows can only
//    collide on casing/whitespace; one address is one person either way.
const emailSibling = (id, extra = {}) => sibling(id, {
  phone: '+353870000000', email: 'SAM.New@Example.com', ...extra,
})
// Helper for the grouped case: same phone-only row, but named in the group.
const grouped = (ids) => ['c-new', ...ids]

/**
 * Fake db. Traces every select's column string (a double that ignores its
 * select argument is how a column gets silently dropped from the real query
 * with no test noticing) and answers each query SHAPE the way PostgREST
 * would, so the sibling searches are genuinely exercised:
 *   • contacts .eq('id')            → the anchor row
 *   • contacts .in('id', [...])     → group members
 *   • contacts .or('phone.ilike…')  → phone-suffix matches (location-scoped)
 *   • contacts .ilike('email', …)   → exact email matches (location-scoped)
 */
function makeDb({
  contact,
  siblings = [],
  groupMemberIds = [],
  pendingApprovals = [],
  phoneSearchError = null,
} = {}) {
  const selects = []
  const inCalls = []
  const inserts = []
  const updates = []
  const all = [contact, ...siblings]

  const from = (table) => {
    const st = { table, cols: '', filters: {}, or: null, ilike: null, op: null }
    const settle = (single) => {
      if (table === 'contacts') {
        let rows
        if (st.or) {
          if (phoneSearchError) return { data: null, error: phoneSearchError }
          const nums = [...st.or.matchAll(/ilike\.%(\d+)/g)].map((m) => m[1])
          rows = all.filter((c) => nums.some((n) => [c.phone, c.wa_phone]
            .some((p) => typeof p === 'string' && p.replace(/\D/g, '').endsWith(n))))
        } else if (st.ilike) {
          rows = all.filter((c) => (c.email || '').toLowerCase() === st.ilike.toLowerCase())
        } else if (Array.isArray(st.filters.id)) {
          rows = all.filter((c) => st.filters.id.includes(c.id))
        } else if (st.filters.id) {
          rows = all.filter((c) => c.id === st.filters.id)
        } else {
          rows = all
        }
        if (st.filters.location_id) rows = rows.filter((c) => c.location_id === st.filters.location_id)
        return single ? { data: rows[0] || null, error: null } : { data: rows, error: null }
      }
      if (table === 'person_group_members') {
        if (st.cols.includes('group_id')) {
          return { data: groupMemberIds.length ? { group_id: 'g-1' } : null, error: null }
        }
        return { data: groupMemberIds.map((id) => ({ contact_id: id })), error: null }
      }
      if (table === 'agent_membership_requests') {
        if (st.op === 'insert') return { data: { id: 'amr-new' }, error: null }
        const ids = Array.isArray(st.filters.contact_id) ? st.filters.contact_id : [st.filters.contact_id]
        const hit = pendingApprovals.find((p) => ids.includes(p.contact_id))
        return { data: single ? (hit || null) : (hit ? [hit] : []), error: null }
      }
      return { data: single ? null : [], error: null }
    }
    const b = {
      select(cols) { selects.push({ table, cols: cols || '' }); st.cols = cols || ''; return b },
      eq(col, val) { st.filters[col] = val; return b },
      in(col, vals) { inCalls.push({ table, col, vals: [...vals] }); st.filters[col] = vals; return b },
      or(expr) { st.or = expr; return b },
      ilike(col, val) { st.ilike = val; return b },
      is() { return b },
      contains() { return b },
      limit() { return b },
      order() { return b },
      insert(row) { st.op = 'insert'; inserts.push({ table, row }); return b },
      update(patch) { st.op = 'update'; updates.push({ table, patch }); return b },
      async maybeSingle() { return settle(true) },
      async single() { return settle(true) },
      then(resolve, reject) { return Promise.resolve(settle(false)).then(resolve, reject) },
    }
    return b
  }
  return { selects, inCalls, inserts, updates, from }
}

const amrInsert = (db) => db.inserts.find((i) => i.table === 'agent_membership_requests')?.row

beforeEach(() => {
  // mockReset, not clearAllMocks: `mockResolvedValueOnce` queues an
  // implementation that `mockClear` does NOT drain, so a test queueing two and
  // consuming one used to leak the spare into whichever test ran next (it
  // silently mis-answered the location-scoping test for one run of this
  // file). Reset drains the queue; the defaults are re-stated below.
  vi.clearAllMocks()
  for (const m of [findOrCreateGlofoxMember, createBooking, fetchUserCredits, fetchUserBookingsResult, computeCreditsRemaining]) m.mockReset()
  computeCreditsRemaining.mockReturnValue(3)
  // Default: the Glofox email search finds NOBODY. Every lane that depends on
  // the search finding an account says so explicitly.
  findOrCreateGlofoxMember.mockResolvedValue({ status: 'skipped', glofox_member_id: null })
  fetchUserCredits.mockResolvedValue([{ active: true, available: 3 }])
  fetchUserBookingsResult.mockResolvedValue({ ok: true, bookings: [] })
  createBooking.mockResolvedValue({ ok: true, status: 200, body: { _id: 'gfb-1' } })
})

describe('the funnel reuses a REUSABLE sibling account instead of minting', () => {
  it('books the SIBLING account and never calls findOrCreateGlofoxMember with createIfMissing', async () => {
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
      groupMemberIds: grouped(['c-old']),
    })
    const r = await processClassBookingRequest(db, req)

    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-old' }))
    // The whole point: no mint, and not even the search-mode call (the
    // account was already in hand).
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalled()
  })

  it('finds the sibling through the person GROUP too (no shared identifier needed to be seen, one needed to be used)', async () => {
    const db = makeDb({
      contact: funnelContact(),
      // Grouped AND corroborated (shares the phone) → usable.
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
      groupMemberIds: ['c-new', 'c-old'],
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-old' }))
  })

  // The one identifier that IS an identity here: contacts_email_unique is
  // global, so an exact (case-insensitive) match means one person — no group
  // needed.
  it('matches on EMAIL with no group at all (the address is the identity)', async () => {
    const db = makeDb({
      contact: funnelContact({ phone: '+353870000000', email: 'SAM@example.com' }),
      siblings: [sibling('c-old', { phone: '+353871111111', email: 'sam@example.com', glofox_member_id: 'gm-old' })],
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-old' }))
  })

  it('records executing_contact_id + elected_glofox_member_id when the booking then fails', async () => {
    createBooking.mockResolvedValueOnce({ ok: false, status: 400, body: { message_code: 'EVENT_FULL' } })
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
      groupMemberIds: grouped(['c-old']),
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('needs_review')
    const row = amrInsert(db)
    // Filed against the FUNNEL row (attribution: ctwa_clid, and the phone the
    // customer just typed is where the confirmation goes)…
    expect(row.contact_id).toBe('c-new')
    // …but naming the account the write belongs to, so the executor's
    // cross-check and Fix & retry stay coherent.
    expect(row.details.executing_contact_id).toBe('c-old')
    expect(row.details.elected_glofox_member_id).toBe('gm-old')
  })
})

// THE COUPLE CASE. Live at Stillorgan: 326 phone-groups, 62 with different
// first names, 59 of those holding multiple Glofox accounts. A shared number
// is not a shared identity, and core.js's resolveAutoVerify already refuses to
// auto-verify on one (core.test.js, "the couple case").
describe('a PHONE-ONLY sibling is never written to', () => {
  it('phone-only sibling with an account → account_ambiguous: no reuse, no mint', async () => {
    const db = makeDb({
      contact: funnelContact(),
      // Not grouped, different email — the direct phone search is the ONLY
      // thing tying these two rows together. It might be Sam's partner.
      siblings: [sibling('c-partner', { glofox_member_id: 'gm-partner' })],
    })
    const r = await processClassBookingRequest(db, req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'account_ambiguous' })
    // Neither half of the wrong-account write happened:
    expect(createBooking).not.toHaveBeenCalled()
    expect(createBooking).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-partner' }))
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
  })

  it('the SAME row, once person-detect has grouped it, IS reusable (the group is the vetting)', async () => {
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
      groupMemberIds: grouped(['c-old']),
    })
    const r = await processClassBookingRequest(db, req)

    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-old' }))
  })

  it("a phone-only sibling's credits are never spent — review instead", async () => {
    fetchUserCredits.mockImplementation(async (_c, memberId) => (memberId === 'gm-partner' ? ['rich'] : []))
    computeCreditsRemaining.mockImplementation((rows) => (rows?.length ? 2 : 0))
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor', last_attended_at: '2026-06-01T10:00:00Z' }),
      siblings: [sibling('c-partner', { glofox_member_id: 'gm-partner' })],
    })
    const r = await processClassBookingRequest(db, req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  it("a phone-only sibling's MEMBERSHIP is never ridden either", async () => {
    computeCreditsRemaining.mockReturnValue(0)
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor', last_attended_at: '2026-06-01T10:00:00Z' }),
      siblings: [sibling('c-partner', {
        glofox_member_id: 'gm-partner',
        glofox_membership_status: 'member', glofox_membership_state: 'active',
      })],
    })
    const r = await processClassBookingRequest(db, req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  // The conservative half stays wide on purpose: this only ever withholds a
  // free class and asks a human, so a partner's history costs a review, never
  // a charge.
  it("but a phone-only sibling's ATTENDANCE still blocks the free trial", async () => {
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-partner', { last_attended_at: '2026-06-01T10:00:00Z' })],
    })
    const r = await processClassBookingRequest(db, req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
  })
})

describe('a weak (uncorroborated) match never mints and never books', () => {
  it('a grouped sibling with an account but no shared phone/email → account_ambiguous, no mint', async () => {
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-other', {
        glofox_member_id: 'gm-other', phone: '+353879999999', email: 'someone.else@example.com',
      })],
      groupMemberIds: ['c-new', 'c-other'],
    })
    const r = await processClassBookingRequest(db, req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'account_ambiguous' })
    expect(createBooking).not.toHaveBeenCalled()
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
  })

  it('a corroborated sibling we cannot WRITE to (ClassPass) still blocks the mint', async () => {
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-cp', { glofox_member_id: 'gm-cp', glofox_membership_status: 'classpass_payg' })],
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('needs_review')
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
  })

  it('an UNREADABLE sibling search never becomes "no such person" — it blocks the mint too', async () => {
    const db = makeDb({
      contact: funnelContact(),
      phoneSearchError: { message: 'boom' },
    })
    const r = await processClassBookingRequest(db, req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'account_check_failed' })
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
  })

  it('a sibling at ANOTHER location is not this person here (location scoping)', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'created', glofox_member_id: 'gm-new' })
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-elsewhere', { glofox_member_id: 'gm-elsewhere', location_id: 'loc-2' })],
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-new' }))
  })
})

describe('attendance is judged across the PERSON', () => {
  it("a sibling's attendance stamp blocks the free trial (a new email cannot dodge it)", async () => {
    computeCreditsRemaining.mockReturnValue(0)
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old', last_attended_at: '2026-06-01T10:00:00Z' })],
      groupMemberIds: grouped(['c-old']),
    })
    const r = await processClassBookingRequest(db, req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(createBooking).not.toHaveBeenCalled()
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
  })

  it("a sibling's GLOFOX history blocks it too (stale local stamp, wide 5-year check)", async () => {
    computeCreditsRemaining.mockReturnValue(0)
    fetchUserBookingsResult.mockImplementation(async (_c, memberId) => (
      memberId === 'gm-old'
        ? { ok: true, bookings: [{ attended: true, time_start: 1700000000 }] }
        : { ok: true, bookings: [] }
    ))
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
      groupMemberIds: grouped(['c-old']),
    })
    const r = await processClassBookingRequest(db, req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  // The fan-out proper: this row has its OWN account with no history, and the
  // attendance sits on a sibling's account. Checking only the account we are
  // writing to would call this person brand-new.
  it("a SIBLING account's Glofox history counts even when this row has its own account", async () => {
    computeCreditsRemaining.mockReturnValue(0)
    fetchUserBookingsResult.mockImplementation(async (_c, memberId) => (
      memberId === 'gm-old'
        ? { ok: true, bookings: [{ attended: true, time_start: 1700000000 }] }
        : { ok: true, bookings: [] }
    ))
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor' }),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
    })
    const r = await processClassBookingRequest(db, req)
    // prior_attendance, NOT needs_credit_grant: this is a returner with
    // nothing to book with, not a new lead awaiting a trial credit.
    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('an unreadable attendance check still fails safe to review', async () => {
    fetchUserBookingsResult.mockResolvedValue({ ok: false, bookings: [] })
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
      groupMemberIds: grouped(['c-old']),
    })
    const r = await processClassBookingRequest(db, req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'attendance_check_failed' })
    expect(createBooking).not.toHaveBeenCalled()
  })
})

describe('the balance gate is person-wide, and the booking follows it', () => {
  it('credits on a corroborated sibling book against THAT member id', async () => {
    // The anchor is linked and has attended, but is empty; the sibling holds
    // the credits.
    fetchUserCredits.mockImplementation(async (_c, memberId) => (memberId === 'gm-rich' ? ['rich'] : []))
    computeCreditsRemaining.mockImplementation((rows) => (rows?.length ? 2 : 0))
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor', last_attended_at: '2026-06-01T10:00:00Z' }),
      siblings: [sibling('c-rich', { glofox_member_id: 'gm-rich' })],
      groupMemberIds: grouped(['c-rich']),
    })
    const r = await processClassBookingRequest(db, req)

    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-rich' }))
  })

  it("a sibling's bookable MEMBERSHIP counts (no credit records at all) and takes the write", async () => {
    computeCreditsRemaining.mockReturnValue(0)
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor', last_attended_at: '2026-06-01T10:00:00Z' }),
      siblings: [sibling('c-member', {
        glofox_member_id: 'gm-member',
        glofox_membership_status: 'member', glofox_membership_state: 'active',
      })],
      groupMemberIds: grouped(['c-member']),
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-member' }))
  })

  it('a ClassPass sibling is never rescued onto (its ledger is ClassPass’s own)', async () => {
    computeCreditsRemaining.mockReturnValue(0)
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor', last_attended_at: '2026-06-01T10:00:00Z' }),
      siblings: [sibling('c-cp', {
        glofox_member_id: 'gm-cp',
        glofox_membership_status: 'classpass_payg', glofox_membership_state: 'active',
      })],
      groupMemberIds: grouped(['c-cp']),
    })
    const r = await processClassBookingRequest(db, req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  // Corroboration gates the WRITE, not just the mint: spending a stranger's
  // credits (a name-ish group match) is the same error as booking their class.
  it("an UNCORROBORATED sibling's credits are never spent — review instead", async () => {
    fetchUserCredits.mockImplementation(async (_c, memberId) => (memberId === 'gm-stranger' ? ['rich'] : []))
    computeCreditsRemaining.mockImplementation((rows) => (rows?.length ? 2 : 0))
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor', last_attended_at: '2026-06-01T10:00:00Z' }),
      siblings: [sibling('c-stranger', {
        glofox_member_id: 'gm-stranger', phone: '+353879999999', email: 'someone.else@example.com',
      })],
      groupMemberIds: ['c-new', 'c-stranger'],
    })
    const r = await processClassBookingRequest(db, req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('the never-attended lane rescues onto a sibling with credits instead of asking for a grant', async () => {
    fetchUserCredits.mockImplementation(async (_c, memberId) => (memberId === 'gm-rich' ? ['rich'] : []))
    computeCreditsRemaining.mockImplementation((rows) => (rows?.length ? 2 : 0))
    const db = makeDb({
      contact: funnelContact({ glofox_member_id: 'gm-anchor' }),
      siblings: [emailSibling('c-rich', { glofox_member_id: 'gm-rich' })],
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-rich' }))
  })
})

describe('a genuinely new person is untouched', () => {
  it('no siblings anywhere → search, create, grant the trial, book, confirm', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null }) // search mode
      .mockResolvedValueOnce({ status: 'created', glofox_member_id: 'gm-new' }) // create mode
    const db = makeDb({ contact: funnelContact() })
    const r = await processClassBookingRequest(db, req)

    expect(r.outcome).toBe('booked')
    expect(findOrCreateGlofoxMember).toHaveBeenNthCalledWith(1, expect.objectContaining({ createIfMissing: false }))
    expect(findOrCreateGlofoxMember).toHaveBeenNthCalledWith(2, expect.objectContaining({ createIfMissing: true, attachTrial: true }))
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-new' }))
  })

  it('a sibling with neither an account NOR attendance is not evidence of anything — still mints', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'created', glofox_member_id: 'gm-new' })
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-empty')],
    })
    const r = await processClassBookingRequest(db, req)
    expect(r.outcome).toBe('booked')
    expect(findOrCreateGlofoxMember).toHaveBeenNthCalledWith(2, expect.objectContaining({ createIfMissing: true }))
  })
})

describe('the approval dedupe is person-wide', () => {
  it("a SIBLING's pending row for the same class prevents a second card", async () => {
    createBooking.mockResolvedValue({ ok: false, status: 400, body: { message_code: 'EVENT_FULL' } })
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
      groupMemberIds: grouped(['c-old']),
      pendingApprovals: [{ id: 'amr-existing', contact_id: 'c-old' }],
    })
    const r = await processClassBookingRequest(db, req)

    expect(r.outcome).toBe('needs_review')
    expect(amrInsert(db)).toBeUndefined() // reused, not re-filed
    const patch = db.updates.find((u) => u.table === 'class_booking_requests')?.patch
    expect(patch.approval_request_id).toBe('amr-existing')
  })

  it('the lookup is chunked at ≤150 ids per .in()', async () => {
    createBooking.mockResolvedValue({ ok: false, status: 400, body: { message_code: 'EVENT_FULL' } })
    const many = Array.from({ length: 200 }, (_, i) => sibling(`c-${String(i).padStart(3, '0')}`))
    many[0] = { ...many[0], glofox_member_id: 'gm-old' }
    const db = makeDb({
      contact: funnelContact(), siblings: many,
      groupMemberIds: grouped(many.map((m) => m.id)),
    })
    await processClassBookingRequest(db, req)

    const amrIns = db.inCalls.filter((c) => c.table === 'agent_membership_requests')
    expect(amrIns.length).toBeGreaterThan(1)
    for (const call of amrIns) expect(call.vals.length).toBeLessThanOrEqual(150)
  })
})

describe('select-string pins (a predicate must never read a column the query did not select)', () => {
  it('the anchor read asks for every column the election + corroboration touch', async () => {
    const db = makeDb({ contact: funnelContact({ glofox_member_id: 'gm-anchor' }) })
    await processClassBookingRequest(db, req)
    const cols = db.selects.find((s) => s.table === 'contacts').cols
    for (const col of [
      'glofox_member_id', 'glofox_membership_status', 'glofox_membership_state',
      'trial_credits_remaining', 'last_attended_at', 'updated_at', 'location_id',
      'phone', 'wa_phone', 'email',
    ]) expect(cols).toContain(col)
  })

  it('the sibling reads ask for the same columns (election reads them on a SIBLING row too)', async () => {
    const db = makeDb({
      contact: funnelContact(),
      siblings: [sibling('c-old', { glofox_member_id: 'gm-old' })],
    })
    await processClassBookingRequest(db, req)
    // Every contacts select after the anchor's — the group fetch and both
    // direct searches — must carry the shared column list.
    // The multi-column contacts reads only: the anchor's (index 0, pinned by
    // the test above) and the single-column ctwa_clid read the Meta CAPI
    // helper makes after the booking are not sibling reads.
    const siblingSelects = db.selects
      .filter((s) => s.table === 'contacts' && s.cols.split(',').length > 3)
      .slice(1)
    expect(siblingSelects.length).toBeGreaterThan(0)
    for (const s of siblingSelects) {
      for (const col of [
        'glofox_member_id', 'glofox_membership_status', 'glofox_membership_state',
        'trial_credits_remaining', 'last_attended_at', 'updated_at', 'location_id',
        'phone', 'wa_phone', 'email',
      ]) expect(s.cols).toContain(col)
    }
  })
})
