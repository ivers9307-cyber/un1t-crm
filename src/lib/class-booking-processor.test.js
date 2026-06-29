import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
  fetchUserCredits: vi.fn(async () => [{ active: true, available: 3 }]),
  GLOFOX_BOOKING_MODEL: 'event',
}))
vi.mock('@/lib/glofox-sync', () => ({ computeCreditsRemaining: vi.fn(() => 3) }))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'created', glofox_member_id: 'gm1' })) }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: vi.fn(async () => ({ sent: true })), CLASS_CONFIRM_TEMPLATE: 'booking_class_confirmed_' }))

import { processClassBookingRequest } from './class-booking-processor'
import { createBooking } from '@/lib/glofox'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { maybeSendBookingWhatsappConfirm, CLASS_CONFIRM_TEMPLATE } from '@/lib/automations/booking-whatsapp-confirm'

function makeDb(contact) {
  const api = {
    from() { return this },
    select() { return this }, eq() { return this }, is() { return this }, contains() { return this }, limit() { return this },
    maybeSingle: async () => ({ data: contact }),
    update() { return { eq: () => ({ is: async () => ({}) }) } },
    insert() { return { select: () => ({ maybeSingle: async () => ({ data: { id: 'amr1' } }), single: async () => ({ data: { id: 'amr1' } }) }) } },
  }
  return api
}
beforeEach(() => vi.clearAllMocks())

describe('processClassBookingRequest', () => {
  const req = { id: 'r1', location_id: 'L', contact_id: 'c1', glofox_event_id: 'e1', class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z' }
  it('routes prior-attendance leads to review, never books', async () => {
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', last_attended_at: '2026-06-01T10:00:00Z' }), req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })
  it('brand-new lead: creates account, books, confirms', async () => {
    const r = await processClassBookingRequest(makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: null, last_attended_at: null }), req)
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
})
