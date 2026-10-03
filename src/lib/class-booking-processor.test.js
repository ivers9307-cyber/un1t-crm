import { describe, it, expect, vi, beforeEach } from 'vitest'
// Partial mock: interpretBookingResult stays REAL (it decides booked vs review).
// CBPCREDITREAD.1 — the processor reads fetchUserCreditsResult. By default it
// answers { ok: true } from the fetchUserCredits knob, so every existing test
// still steers the balance the way it always has (computeCreditsRemaining);
// a failed read is a per-test mockResolvedValueOnce({ ok: false, credits: [] }).
vi.mock('@/lib/glofox', async (importOriginal) => {
  const fetchUserCredits = vi.fn(async () => [{ active: true, available: 3 }])
  return {
    ...(await importOriginal()),
    glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
    missingGlofoxCredentialsForLocation: vi.fn(() => []),
    createBooking: vi.fn(async () => ({ ok: true, status: 200, body: { _id: 'gfb-1' } })),
    fetchUserCredits,
    fetchUserCreditsResult: vi.fn(async (creds, id) => ({ ok: true, credits: await fetchUserCredits(creds, id) })),
    fetchUserBookingsResult: vi.fn(async () => ({ ok: true, bookings: [] })),
    GLOFOX_BOOKING_MODEL: 'event',
  }
})
vi.mock('@/lib/glofox-sync', () => ({ computeCreditsRemaining: vi.fn(() => 3) }))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'created', glofox_member_id: 'gm1' })) }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: vi.fn(async () => ({ sent: true })), CLASS_CONFIRM_TEMPLATE: 'booking_class_confirmed_' }))

import { processClassBookingRequest, CreditReadError } from './class-booking-processor'
import { createBooking, fetchUserBookingsResult, fetchUserCreditsResult, glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { maybeSendBookingWhatsappConfirm, CLASS_CONFIRM_TEMPLATE } from '@/lib/automations/booking-whatsapp-confirm'

function makeDb(contact) {
  // Every select is traced (table + the exact column string requested), not
  // just resolved regardless of it — a double that ignores its select
  // argument is how a column gets silently dropped from the real query with
  // no test noticing (a real quality gap found in this task: the
  // glofox_membership_state widening was unpinned until this fix).
  const selects = []
  const api = {
    selects,
    _table: null,
    from(table) { this._table = table; return this },
    select(cols) { selects.push({ table: this._table, cols }); return this },
    eq() { return this }, is() { return this }, contains() { return this }, limit() { return this },
    // PERSON-ACCT.9 — the processor now also asks "who else is this person?"
    // (a person-group `.in()`, a phone `.or()`, an email `.ilike()`) before it
    // is allowed to mint a Glofox account. This double answers those with an
    // EMPTY result set — the single-row world every test below describes —
    // rather than throwing, which the processor would (correctly) treat as an
    // unreadable person and refuse to mint over. The person-wide behaviour has
    // its own file: class-booking-processor-person.test.js.
    or() { return this }, ilike() { return this }, in() { return this }, order() { return this },
    then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject) },
    maybeSingle: async () => ({ data: contact }),
    update() { return { eq: () => ({ is: async () => ({}) }) } },
    insert() { return { select: () => ({ maybeSingle: async () => ({ data: { id: 'amr1' } }), single: async () => ({ data: { id: 'amr1' } }) }) } },
  }
  return api
}
beforeEach(() => vi.clearAllMocks())

describe('processClassBookingRequest', () => {
  const req = { id: 'r1', location_id: 'L', contact_id: 'c1', glofox_event_id: 'e1', class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z' }
  // AGENT-FUNNEL-CREDITS.1 — prior attendance books when the account holds a
  // usable balance; review is only for returners with nothing to book with.
  it('prior attendance WITH credits → books against the balance (no trial grant)', async () => {
    // default mocks: credits 3
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: '2026-06-01T10:00:00Z' }), req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalled()
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalled() // no create, no trial
  })
  it('prior attendance with NO credits and no active membership → review, never books', async () => {
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', glofox_membership_status: 'trial', last_attended_at: '2026-06-01T10:00:00Z' }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  // PERSON-ACCT.3 — glofox_membership_status is NEVER the string 'active'
  // in prod (real values: member, credit_member, trial, classpass_payg,
  // lead, ...); a bookable membership is status 'member'/'credit_member'
  // with a state that hasn't ended (hasBookableMembership).
  it('prior attendance, null credits but a bookable membership (member + active state) → books (Glofox arbitrates)', async () => {
    computeCreditsRemaining.mockReturnValueOnce(null)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', glofox_membership_status: 'member', glofox_membership_state: 'active', last_attended_at: '2026-06-01T10:00:00Z' }), req)
    expect(r.outcome).toBe('booked')
  })
  it('prior attendance, null credits, a classpass_payg account with state active → still review (classpass is never a bookable membership)', async () => {
    computeCreditsRemaining.mockReturnValueOnce(null)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', glofox_membership_status: 'classpass_payg', glofox_membership_state: 'active', last_attended_at: '2026-06-01T10:00:00Z' }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  it('prior attendance with no Glofox account at all → review (nothing to book with)', async () => {
    findOrCreateGlofoxMember.mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: null, last_attended_at: '2026-06-01T10:00:00Z' }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  it('brand-new lead: creates account, books, confirms', async () => {
    // Search (createIfMissing:false) finds nobody → not in Glofox → clean create path.
    findOrCreateGlofoxMember.mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', last_name: 'Lee', phone: '0871234567', glofox_member_id: null, last_attended_at: null }), req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalled()
    // Must use the shared template constant (matching the live APPROVED name),
    // not a hardcoded literal — guards the trailing-underscore typo from regressing.
    expect(maybeSendBookingWhatsappConfirm).toHaveBeenCalledWith(expect.objectContaining({ templateName: CLASS_CONFIRM_TEMPLATE }))
  })
  it('booking failure → review', async () => {
    createBooking.mockResolvedValueOnce({ ok: false, status: 400, body: { message_code: 'EVENT_FULL' } })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('needs_review')
  })
  it('ambiguous Glofox account (multiple matches) → review, never books', async () => {
    findOrCreateGlofoxMember.mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-guess' })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', last_name: 'Lee', phone: '0871234567', glofox_member_id: null, last_attended_at: null }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  it('existing account with no live credits → review (no fragile auto-purchase)', async () => {
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  it('wide attendance check catches a repeat trainer with stale last_attended_at → balance gate (review when broke)', async () => {
    // last_attended_at is NULL (stale), but the live booking history shows a prior attended class.
    fetchUserBookingsResult.mockResolvedValueOnce({ ok: true, bookings: [{ attended: true, time_start: 1700000000 }] })
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  it('wide-check repeat trainer WITH credits → books against the balance', async () => {
    fetchUserBookingsResult.mockResolvedValueOnce({ ok: true, bookings: [{ attended: true, time_start: 1700000000 }] })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('booked')
  })
  it('uncertain attendance read (Glofox error) → review, never books', async () => {
    fetchUserBookingsResult.mockResolvedValueOnce({ ok: false, bookings: [] })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  // MIA-BOOKCHECK — Glofox can 200 with a failure body; without a created
  // booking id that is a FAILURE, not a booking (never confirm to the lead).
  it('HTTP 200 with a failure body (no booking id) → review, no WhatsApp confirm', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('needs_review')
    expect(maybeSendBookingWhatsappConfirm).not.toHaveBeenCalled()
  })
  // GLOFOXWRITEJUDGE.1 — Glofox: a 200 with success:false is a bad request.
  // With no code and no id it used to read as booked (and confirm to the lead).
  it('HTTP 200 success:false with no code and no id → review (booking_failed:status_200), no WhatsApp confirm', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: false } })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r).toMatchObject({ outcome: 'needs_review', detail: 'booking_failed:status_200' })
    expect(maybeSendBookingWhatsappConfirm).not.toHaveBeenCalled()
  })
  it('the live success shape { success, Booking } still books (unchanged)', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: 'gfb-9' } } })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('booked')
  })
  it('Glofox "already booked" (reaper re-run) → booked, not review', async () => {
    createBooking.mockResolvedValueOnce({ ok: false, status: 400, body: { message_code: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT' } })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)
    expect(r.outcome).toBe('booked')
  })

  // Quality-review finding: makeDb used to return the fixture regardless of
  // what was requested, so the select() string itself was never exercised —
  // a future editor could drop glofox_membership_state from the query and
  // every test here would stay green while hasBookableMembership silently
  // returned false forever. Pin the column list, not just the shape it
  // happens to produce today.
  it('the contacts select includes glofox_membership_state and glofox_member_id (pins the widened column list)', async () => {
    const db = makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', glofox_membership_status: 'member', glofox_membership_state: 'active', last_attended_at: '2026-06-01T10:00:00Z' })
    await processClassBookingRequest(db, req)
    const contactsSelect = db.selects.find((s) => s.table === 'contacts')
    expect(contactsSelect).toBeTruthy()
    expect(contactsSelect.cols).toContain('glofox_membership_state')
    expect(contactsSelect.cols).toContain('glofox_member_id')
  })

  // REGISTRYREAD.1a — an unreadable Glofox settings row is not "not
  // configured". 'failed' is terminal; a THROW is the queue's retry signal
  // (claimAndProcessBookingJob re-queues under MAX_ATTEMPTS, then needs_review
  // with a staff card: class-booking-retries-exhausted.test.js).
  it('an unreadable settings row THROWS (the queue retries it) and stamps nothing', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: 'glofox_settings_unreadable' })
    const db = makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567' })
    const statusWrites = []
    db.update = (patch) => { statusWrites.push(patch); return { eq: async () => ({}), is: async () => ({}) } }
    await expect(processClassBookingRequest(db, req)).rejects.toThrow(/glofox_settings_unreadable/)
    expect(statusWrites).toEqual([])
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('a genuinely unconfigured studio still lands failed glofox_not_configured (unchanged)', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: null })
    missingGlofoxCredentialsForLocation.mockReturnValueOnce(['Branch ID', 'API Key', 'API Token'])
    const db = makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567' })
    const statusWrites = []
    db.update = (patch) => { statusWrites.push(patch); return { eq: async () => ({}), is: async () => ({}) } }
    const r = await processClassBookingRequest(db, req)
    expect(r).toEqual({ outcome: 'failed', detail: 'glofox_not_configured' })
    expect(statusWrites).toEqual([{ status: 'failed', last_error: 'glofox_not_configured' }])
  })

  // MANUALFUNNEL.1 — a class off a hand-written timetable at a studio with no
  // Glofox goes to staff, who book it by hand.
  it('a manual-timetable class at a studio with no Glofox → staff card manual_booking; nothing is booked, minted or sent', async () => {
    glofoxCredentialsForLocation.mockResolvedValueOnce({ branchId: null, apiKey: null, apiToken: null, readError: null })
    missingGlofoxCredentialsForLocation.mockReturnValueOnce(['Branch ID', 'API Key', 'API Token'])
    const db = makeDb(null) // no pending card to reuse
    const inserts = []
    const statusWrites = []
    db.insert = (row) => { inserts.push(row); return { select: () => ({ maybeSingle: async () => ({ data: { id: 'amr1' } }) }) } }
    db.update = (patch) => { statusWrites.push(patch); return { eq: async () => ({}), is: async () => ({}) } }
    const manualReq = { ...req, glofox_event_id: 'manual-20261005-0615-strength', class_name: 'Strength', starts_at: '2026-10-05T05:15:00.000Z', customer_name: 'Sam Byrne' }
    const r = await processClassBookingRequest(db, manualReq)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'manual_booking' })
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      location_id: 'L', contact_id: 'c1', kind: 'class_booking', status: 'pending',
      details: { event_id: 'manual-20261005-0615-strength', class_name: 'Strength', starts_at: '2026-10-05T05:15:00.000Z', source: 'start_funnel', reason: 'manual_booking' },
    })
    expect(statusWrites).toEqual([{ status: 'needs_review', last_error: 'manual_booking', approval_request_id: 'amr1' }])
    expect(createBooking).not.toHaveBeenCalled()
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalled()
    expect(maybeSendBookingWhatsappConfirm).not.toHaveBeenCalled()
  })

  it('a manual-looking id at a studio WITH Glofox is not special: it takes the normal path', async () => {
    createBooking.mockResolvedValueOnce({ ok: false, status: 404, body: { message_code: 'EVENT_NOT_FOUND' } })
    const db = makeDb({ id: 'c1', first_name: 'Sam', last_name: 'Byrne', phone: '0871234567', glofox_member_id: null, last_attended_at: null })
    const r = await processClassBookingRequest(db, { ...req, glofox_event_id: 'manual-20261005-0615-strength' })
    expect(r.detail).not.toBe('manual_booking')
  })
})

// CBPCREDITREAD.1 — a credits read that FAILED is "unknown", never "no
// credits". It throws (the queue's retry signal) instead of filing a
// needs_credit_grant card (whose approve buys a trial membership) or a
// prior_attendance card ("no usable balance was found").
describe('CBPCREDITREAD.1: a failed credits read is a retry, never "no credits"', () => {
  const req = { id: 'r1', location_id: 'L', contact_id: 'c1', glofox_event_id: 'e1', class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z' }
  const unread = { ok: false, credits: [] }
  // Records every status write and every card insert, so "nothing was
  // stamped, no card was filed" is asserted, not assumed.
  function tracedDb(contact) {
    const db = makeDb(contact)
    db.statusWrites = []
    db.cardInserts = []
    db.update = (patch) => { db.statusWrites.push(patch); return { eq: async () => ({}), is: async () => ({}) } }
    db.insert = (row) => { db.cardInserts.push(row); return { select: () => ({ maybeSingle: async () => ({ data: { id: 'amr1' } }) }) } }
    return db
  }

  it('never-attended linked account, credits read fails → throws CreditReadError; no card, no stamp, no booking', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce(unread)
    const db = tracedDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null })

    const err = await processClassBookingRequest(db, req).catch((e) => e)

    expect(err).toBeInstanceOf(CreditReadError)
    expect(err.message).toBe('credit_check_failed')
    expect(err.reviewReason).toBe('credit_check_failed')
    expect(err.reviewOptions.creditUnreadAccounts).toEqual([{ role: 'booking_account', contact_id: 'c1', glofox_member_id: 'gm1' }])
    expect(db.statusWrites).toEqual([])
    expect(db.cardInserts).toEqual([])
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('returner with no bookable membership, credits read fails → throws (not prior_attendance)', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce(unread)
    const db = tracedDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', glofox_membership_status: 'trial', last_attended_at: '2026-06-01T10:00:00Z' })

    await expect(processClassBookingRequest(db, req)).rejects.toBeInstanceOf(CreditReadError)
    expect(db.cardInserts).toEqual([])
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('returner WITH a bookable membership still books when the credits read fails (Glofox arbitrates, as before)', async () => {
    fetchUserCreditsResult.mockResolvedValueOnce(unread)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', glofox_membership_status: 'member', glofox_membership_state: 'active', last_attended_at: '2026-06-01T10:00:00Z' }), req)

    expect(r).toEqual({ outcome: 'booked' })
    expect(createBooking).toHaveBeenCalled()
  })

  it('a read that WORKED and found zero still files needs_credit_grant (unchanged)', async () => {
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }), req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'needs_credit_grant' })
  })

  it('a returner whose read WORKED and found nothing still files prior_attendance (unchanged)', async () => {
    computeCreditsRemaining.mockReturnValueOnce(null)
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', glofox_membership_status: 'trial', last_attended_at: '2026-06-01T10:00:00Z' }), req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
  })

  it('a brand-new lead never reads credits (the mint grants the trial), so a Glofox credits outage cannot hold it up', async () => {
    findOrCreateGlofoxMember.mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', last_name: 'Lee', phone: '0871234567', glofox_member_id: null, last_attended_at: null }), req)

    expect(r).toEqual({ outcome: 'booked' })
    expect(fetchUserCreditsResult).not.toHaveBeenCalled()
  })
})

// TRIALGRANT.1 — the mint path created the Glofox account but its trial did
// not take (the purchase is judged on its body now). That is the card whose
// approve buys the trial and books: needs_credit_grant, not
// account_needs_review.
describe('TRIALGRANT.1: a new account whose trial did not take', () => {
  const req = { id: 'r1', location_id: 'L', contact_id: 'c1', glofox_event_id: 'e1', class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z' }
  const lead = { id: 'c1', first_name: 'Sam', last_name: 'Lee', phone: '0871234567', glofox_member_id: null, last_attended_at: null }

  it('created, trial failed → needs_credit_grant card, no booking', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-new', trial_failed: true, error: 'Trial membership purchase failed: Membership cannot be purchased' })

    const r = await processClassBookingRequest(makeDb(lead), req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'needs_credit_grant' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('any other needs_review from the mint is still account_needs_review (unchanged)', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-new', error: 'Glofox member created but CRM link write failed: x' })

    const r = await processClassBookingRequest(makeDb(lead), req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'account_needs_review' })
  })

  // The card must carry the funnel's own trial, so its approve buys what the
  // mint would have bought (not the location default).
  it('the needs_credit_grant card carries the funnel block’s trial override', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-new', trial_failed: true, error: 'x' })
    const d = makeDb(lead)
    const inserts = []
    const insert = d.insert
    d.insert = (row) => { inserts.push(row); return insert(row) }
    // No pending card to reuse, so the card is INSERTED (and inspectable).
    d.maybeSingle = async () => ({ data: d._table === 'agent_membership_requests' ? null : lead })

    await processClassBookingRequest(d, { ...req, trial_membership_id: 'tm-funnel', trial_plan_code: 'tp-funnel' })

    expect(inserts).toHaveLength(1)
    expect(inserts[0].details).toMatchObject({ reason: 'needs_credit_grant', trial_membership_id: 'tm-funnel', trial_plan_code: 'tp-funnel' })
  })

  // GLOFOXPOSTRETRY.1 review — the mint's purchase got no clear answer (a
  // 5xx or no reply): the trial may be on the account. The card carries that
  // doubt as details.trial_grant, so its FIRST approval runs the unsettled
  // path (books only if credits show) instead of buying blind.
  it('a mint purchase with no clear answer stamps the card with an unsettled trial grant', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-new', trial_failed: true, trial_outcome_unknown: true, error: 'x' })
    const d = makeDb(lead)
    const inserts = []
    const insert = d.insert
    d.insert = (row) => { inserts.push(row); return insert(row) }
    d.maybeSingle = async () => ({ data: d._table === 'agent_membership_requests' ? null : lead })

    const r = await processClassBookingRequest(d, req)

    expect(r).toEqual({ outcome: 'needs_review', detail: 'needs_credit_grant' })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].details).toMatchObject({
      reason: 'needs_credit_grant',
      trial_grant: { ok: false, code: 'TRIAL_GRANT_FAILED', outcome_unknown: true },
    })
  })

  // TRIALPURCHASE.2 (d) — the doubt names the member, so ANOTHER card for the
  // same person (a second class) sees it and does not buy a trial over it.
  it('the unsettled mint grant on the card names the Glofox member it was for', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-new', trial_failed: true, trial_outcome_unknown: true, error: 'x' })
    const d = makeDb(lead)
    const inserts = []
    const insert = d.insert
    d.insert = (row) => { inserts.push(row); return insert(row) }
    d.maybeSingle = async () => ({ data: d._table === 'agent_membership_requests' ? null : lead })

    await processClassBookingRequest(d, req)

    expect(inserts[0].details.trial_grant).toEqual({ ok: false, code: 'TRIAL_GRANT_FAILED', outcome_unknown: true, glofox_member_id: 'gm-new' })
  })

  it('a mint purchase Glofox REFUSED leaves no trial_grant on the card (its approve may buy)', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-new', trial_failed: true, error: 'x' })
    const d = makeDb(lead)
    const inserts = []
    const insert = d.insert
    d.insert = (row) => { inserts.push(row); return insert(row) }
    d.maybeSingle = async () => ({ data: d._table === 'agent_membership_requests' ? null : lead })

    await processClassBookingRequest(d, req)

    expect(inserts[0].details.trial_grant).toBeUndefined()
  })

  it('no override on the request → none on the card (the approve buys the location default)', async () => {
    findOrCreateGlofoxMember
      .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
      .mockResolvedValueOnce({ status: 'needs_review', glofox_member_id: 'gm-new', trial_failed: true, error: 'x' })
    const d = makeDb(lead)
    const inserts = []
    const insert = d.insert
    d.insert = (row) => { inserts.push(row); return insert(row) }
    // No pending card to reuse, so the card is INSERTED (and inspectable).
    d.maybeSingle = async () => ({ data: d._table === 'agent_membership_requests' ? null : lead })

    await processClassBookingRequest(d, req)

    expect(inserts[0].details).not.toHaveProperty('trial_membership_id')
    expect(inserts[0].details).not.toHaveProperty('trial_plan_code')
  })
})

// GLOFOXWRITEJUDGE.1 review — the mint can now answer 'linked' (Glofox said the
// email already has an account and a second search found it). That account
// may belong to a RETURNER: attendance was read before the link, with no
// account to read, so it must be read again on the linked account before a
// card is chosen. A returner with nothing to book with is prior_attendance
// (no trial offered), never needs_credit_grant (whose approve buys a trial).
describe('GLOFOXWRITEJUDGE.1: the mint linked an existing account (email already in use)', () => {
  const req = { id: 'r1', location_id: 'L', contact_id: 'c1', glofox_event_id: 'e1', class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z' }
  const lead = { id: 'c1', first_name: 'Sam', last_name: 'Lee', phone: '0871234567', glofox_member_id: null, last_attended_at: null }
  const linked = () => findOrCreateGlofoxMember
    .mockResolvedValueOnce({ status: 'skipped', glofox_member_id: null })
    .mockResolvedValueOnce({ status: 'linked', glofox_member_id: 'gm-linked', error: null })
  // No unconsumed Once-answer may leak between these cases: restore defaults.
  beforeEach(() => {
    fetchUserBookingsResult.mockReset(); fetchUserBookingsResult.mockResolvedValue({ ok: true, bookings: [] })
    computeCreditsRemaining.mockReset(); computeCreditsRemaining.mockReturnValue(3)
    findOrCreateGlofoxMember.mockReset(); findOrCreateGlofoxMember.mockResolvedValue({ status: 'created', glofox_member_id: 'gm1' })
  })

  it('a linked returner with no balance → prior_attendance, no trial offered, no booking', async () => {
    linked()
    fetchUserBookingsResult.mockResolvedValueOnce({ ok: true, bookings: [{ attended: true, time_start: 1700000000 }] })
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb(lead), req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'prior_attendance' })
    expect(fetchUserBookingsResult).toHaveBeenCalledWith(expect.anything(), 'gm-linked', expect.anything())
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('a linked returner WITH a balance books against it', async () => {
    linked()
    fetchUserBookingsResult.mockResolvedValueOnce({ ok: true, bookings: [{ attended: true, time_start: 1700000000 }] })
    const r = await processClassBookingRequest(makeDb(lead), req)
    expect(r).toEqual({ outcome: 'booked' })
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: 'gm-linked' }))
  })

  it('the attendance read on the linked account FAILS → attendance_check_failed, never "no attendance"', async () => {
    linked()
    fetchUserBookingsResult.mockResolvedValueOnce({ ok: false, bookings: [] })
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb(lead), req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'attendance_check_failed' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('a linked account that never attended, with no balance → needs_credit_grant (unchanged)', async () => {
    linked()
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb(lead), req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'needs_credit_grant' })
  })
})
