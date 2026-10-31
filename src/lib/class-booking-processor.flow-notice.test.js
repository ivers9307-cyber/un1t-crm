// FLOWACK.1 — the Glofox processor tells a WhatsApp Flow customer the real
// outcome (notifyFlowBookingOutcome decides whether the row came from the Flow
// and owns the copy; its own tests are whatsapp-flow/booking-notice.test.js).
// booked → the class_confirmed template as before, and the in-thread
// confirmation only when that template did not go (never both); review → the
// holding line with the card linked to the thread. A notice never changes the
// booking outcome.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('@/lib/agent/approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => ({})) }))
vi.mock('@/lib/un1t-online-settings', () => ({ readUn1tWriteSettings: vi.fn(async () => ({ membershipSource: 'glofox', settings: {} })) }))
vi.mock('@/lib/whatsapp-flow/booking-notice', () => ({ notifyFlowBookingOutcome: vi.fn(async () => ({ flow: true, sent: true })), readPaidTrialReply: vi.fn(async () => null) }))

import { processClassBookingRequest, routeToReview, closeWithPaidTrialReply } from './class-booking-processor'
import { createBooking, missingGlofoxCredentialsForLocation } from '@/lib/glofox'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { maybeSendBookingWhatsappConfirm } from '@/lib/automations/booking-whatsapp-confirm'
import { notifyFlowBookingOutcome, readPaidTrialReply } from '@/lib/whatsapp-flow/booking-notice'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { fetchUserCredits } from '@/lib/glofox'

function makeDb(contact) {
  const api = {
    _table: null,
    from(table) { this._table = table; return this },
    select() { return this },
    eq() { return this }, is() { return this }, contains() { return this }, limit() { return this },
    or() { return this }, ilike() { return this }, in() { return this }, order() { return this },
    then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject) },
    // Only the contact read answers; no existing card is found, so a new one is filed.
    async maybeSingle() { return { data: this._table === 'contacts' ? contact : null } },
    update() { return { eq: () => ({ is: async () => ({}) }) } },
    insert() { return { select: () => ({ maybeSingle: async () => ({ data: { id: 'amr1' } }), single: async () => ({ data: { id: 'amr1' } }) }) } },
  }
  return api
}

const req = { id: 'r1', location_id: 'L', contact_id: 'c1', glofox_event_id: 'e1', class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z', created_at: '2026-07-07T09:00:00.000Z' }
const member = { id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null }

beforeEach(() => vi.clearAllMocks())

describe('FLOWACK.1 — booked', () => {
  it('the class_confirmed template went: no second (in-thread) confirmation', async () => {
    const r = await processClassBookingRequest(makeDb(member), req)
    expect(r.outcome).toBe('booked')
    expect(maybeSendBookingWhatsappConfirm).toHaveBeenCalledTimes(1)
    expect(notifyFlowBookingOutcome).not.toHaveBeenCalled()
  })

  it('the template did NOT go: a Flow customer gets the in-thread confirmation instead', async () => {
    maybeSendBookingWhatsappConfirm.mockResolvedValueOnce({ sent: false, reason: 'template_not_found' })
    const r = await processClassBookingRequest(makeDb(member), req)
    expect(r.outcome).toBe('booked')
    expect(notifyFlowBookingOutcome).toHaveBeenCalledTimes(1)
    expect(notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), req, { outcome: 'booked', classTime: expect.stringMatching(/8 Jul/) })
  })

  it('a notice that throws never changes the booking outcome', async () => {
    maybeSendBookingWhatsappConfirm.mockResolvedValueOnce({ sent: false, reason: 'send_failed' })
    notifyFlowBookingOutcome.mockRejectedValueOnce(new Error('boom'))
    const r = await processClassBookingRequest(makeDb(member), req)
    expect(r.outcome).toBe('booked')
  })
})

describe('FLOWACK.1 — review', () => {
  it('a filed card: the holding line + the card linked to the thread (approvalId passed)', async () => {
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb(member), req)
    expect(r).toEqual({ outcome: 'needs_review', detail: 'needs_credit_grant' })
    expect(createBooking).not.toHaveBeenCalled()
    expect(notifyFlowBookingOutcome).toHaveBeenCalledTimes(1)
    expect(notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'r1' }), { outcome: 'needs_review', approvalId: 'amr1' })
  })

  it('a booking Glofox refused goes to review and the customer is told it is being confirmed', async () => {
    createBooking.mockResolvedValueOnce({ ok: false, status: 400, body: { message_code: 'EVENT_FULL' } })
    const r = await processClassBookingRequest(makeDb(member), req)
    expect(r.outcome).toBe('needs_review')
    expect(notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'r1' }), { outcome: 'needs_review', approvalId: 'amr1' })
  })

  it('a notice that throws never changes the review outcome', async () => {
    notifyFlowBookingOutcome.mockRejectedValueOnce(new Error('boom'))
    const r = await routeToReview(makeDb(member), req, 'booking_failed:EVENT_FULL')
    expect(r).toEqual({ outcome: 'needs_review', detail: 'booking_failed:EVENT_FULL' })
  })

  it('a retry (no card yet, under the cap) sends nothing: the next attempt decides', async () => {
    const db = makeDb(member)
    db.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null }) }) })
    const r = await routeToReview(db, { ...req, attempts: 0 }, 'booking_failed:EVENT_FULL')
    expect(r.outcome).toBe('needs_review')
    expect(notifyFlowBookingOutcome).not.toHaveBeenCalled()
  })

  it('no card could be filed at the cap (failed): the holding line still goes', async () => {
    const db = makeDb(member)
    db.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null }) }) })
    const r = await routeToReview(db, { ...req, attempts: 99 }, 'booking_failed:EVENT_FULL')
    expect(r.outcome).toBe('failed')
    expect(notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'r1' }), { outcome: 'failed' })
  })
})

describe('FLOWACK.1 — failed without a card', () => {
  it('no Glofox at the studio: the Flow customer still hears that the team will confirm', async () => {
    missingGlofoxCredentialsForLocation.mockReturnValueOnce(['branchId'])
    const r = await processClassBookingRequest(makeDb(member), { ...req, glofox_event_id: '6a44fd4ef7a9ab28b6017da5' })
    expect(r).toEqual({ outcome: 'failed', detail: 'glofox_not_configured' })
    expect(notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'r1' }), { outcome: 'failed' })
  })
})

// FLOWACK.1 review — a record-only card that leaves the row 'failed' with its
// own reason (un1t's trial-used: the customer was just emailed their options)
// gets no "the team is confirming your class" line and no thread link.
describe('FLOWACK.1 — a card whose customer was already told by email', () => {
  it('trial_used_options_sent: no Flow notice at all', async () => {
    const r = await routeToReview(makeDb(member), req, 'un1t_trial_used', { provider: 'un1t_online', rowStatus: 'failed', rowLastError: 'trial_used_options_sent' })
    expect(r.outcome).toBe('needs_review')
    expect(notifyFlowBookingOutcome).not.toHaveBeenCalled()
  })
})

// PAIDTRIALONLY.1 — where the studio has set its paid trial reply, someone new
// is never minted an account or a free trial: they are sent the reply.
describe('PAIDTRIALONLY.1 — paid trial only', () => {
  const REPLY = 'New here? Start with the 14 Day Reset: https://x.test/trial'
  const newcomer = { id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: null, last_attended_at: null }
  const noAccount = async (args) => (args.createIfMissing ? { status: 'created', glofox_member_id: 'gm-new' } : { status: 'skipped' })

  it('brand-new person: no account, no trial, no booking; the Flow customer gets the reply', async () => {
    readPaidTrialReply.mockResolvedValue(REPLY)
    findOrCreateGlofoxMember.mockImplementation(noAccount)
    const r = await processClassBookingRequest(makeDb(newcomer), req)
    expect(r).toEqual({ outcome: 'failed', detail: 'paid_trial_offered' })
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
    expect(createBooking).not.toHaveBeenCalled()
    expect(notifyFlowBookingOutcome).toHaveBeenCalledWith(expect.anything(), req, { outcome: 'paid_trial', text: REPLY })
  })

  it('brand-new person, reply not set: minted with the trial and booked, as before', async () => {
    readPaidTrialReply.mockResolvedValue(null)
    findOrCreateGlofoxMember.mockImplementation(noAccount)
    const r = await processClassBookingRequest(makeDb(newcomer), req)
    expect(r.outcome).toBe('booked')
    expect(findOrCreateGlofoxMember).toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true, attachTrial: true }))
  })

  it('PAGETRIAL.1: both reads ask with the row\'s page, so a free-class page keeps its trial', async () => {
    readPaidTrialReply.mockResolvedValue(null)
    findOrCreateGlofoxMember.mockImplementation(noAccount)
    await processClassBookingRequest(makeDb(newcomer), { ...req, page_id: 'p-50plus' })
    expect(readPaidTrialReply).toHaveBeenCalledWith(expect.anything(), 'L', { pageId: 'p-50plus' })
    readPaidTrialReply.mockClear()
    fetchUserCredits.mockResolvedValueOnce([])
    computeCreditsRemaining.mockReturnValueOnce(0)
    await processClassBookingRequest(makeDb(member), { ...req, page_id: 'p-50plus' })
    expect(readPaidTrialReply).toHaveBeenCalledWith(expect.anything(), 'L', { pageId: 'p-50plus' })
  })

  it('an unreadable reply setting throws (the queue retries) and mints nothing', async () => {
    readPaidTrialReply.mockRejectedValue(new Error('unreadable'))
    findOrCreateGlofoxMember.mockImplementation(noAccount)
    await expect(processClassBookingRequest(makeDb(newcomer), req)).rejects.toThrow('unreadable')
    expect(findOrCreateGlofoxMember).not.toHaveBeenCalledWith(expect.objectContaining({ createIfMissing: true }))
  })

  it('never-attended account with no credits: the reply, not a credit-grant card', async () => {
    readPaidTrialReply.mockResolvedValue(REPLY)
    fetchUserCredits.mockResolvedValueOnce([])
    computeCreditsRemaining.mockReturnValueOnce(0)
    const r = await processClassBookingRequest(makeDb(member), req)
    expect(r).toEqual({ outcome: 'failed', detail: 'paid_trial_offered' })
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('a member with credits still books when the reply is set', async () => {
    readPaidTrialReply.mockResolvedValue(REPLY)
    const r = await processClassBookingRequest(makeDb(member), req)
    expect(r.outcome).toBe('booked')
    expect(readPaidTrialReply).not.toHaveBeenCalled()
  })

  it('closeWithPaidTrialReply records why: offered, not sent, or not a Flow row', async () => {
    const stamp = vi.fn(async () => {})
    const notify = vi.fn()
    notify.mockResolvedValueOnce({ flow: true, sent: true })
    expect(await closeWithPaidTrialReply({}, req, REPLY, { stamp, notify })).toEqual({ outcome: 'failed', detail: 'paid_trial_offered' })
    notify.mockResolvedValueOnce({ flow: true, sent: false, reason: 'window_closed' })
    expect((await closeWithPaidTrialReply({}, req, REPLY, { stamp, notify })).detail).toBe('paid_trial_reply_not_sent')
    notify.mockResolvedValueOnce({ flow: false, sent: false })
    expect((await closeWithPaidTrialReply({}, req, REPLY, { stamp, notify })).detail).toBe('paid_trial_only_not_flow')
    expect(stamp).toHaveBeenLastCalledWith({}, 'r1', { status: 'failed', last_error: 'paid_trial_only_not_flow' })
  })
})
