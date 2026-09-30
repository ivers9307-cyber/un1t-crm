// BOOKCHATCOPY.1 (C111) — the staff Book panel drops a confirmation line into
// the open chat after a consultation booking. That line is customer copy, so
// it is the studio's editable booking confirmation text, handed to the panel
// by this route with the new booking. The booking is already made by then, so
// a failed settings read never fails the response. Ids are synthetic.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOC = 'c0000000-0000-4000-8000-00000000000c'
const CONTACT = 'd0000000-0000-4000-8000-00000000000d'
const EVENT_TYPE = 'e0000000-0000-4000-8000-00000000000e'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'user-s', locations: [{ id: LOC }] })),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForBooking: vi.fn(), triggerSequencesForFirstBooking: vi.fn() }))
vi.mock('@/lib/booking-confirmations', () => ({ sendBookingConfirmation: vi.fn(async () => ({ channels_sent: ['email'] })) }))

let locationRead
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: (table) => {
      const b = {}
      for (const m of ['select', 'eq', 'in', 'lt', 'gt']) b[m] = () => b
      b.insert = () => b
      b.maybeSingle = async () => {
        if (table === 'event_types') return { data: { id: EVENT_TYPE, name: 'Consultation', duration_minutes: 30, location_id: LOC, active: true }, error: null }
        if (table === 'contacts') return { data: { id: CONTACT, name: 'Test Person', email: 'person@example.test', phone: null, location_id: LOC }, error: null }
        if (table === 'locations') return locationRead
        return { data: null, error: null }
      }
      b.single = async () => ({ data: { id: 'bk-1' }, error: null })
      // The overlap check is awaited directly: no conflicts.
      b.then = (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad)
      return b
    },
  })),
}))

import { POST } from './route.js'
import { logWarn } from '@/lib/log'

const create = () => POST(new Request('http://crm.test/api/bookings/create', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event_type_id: EVENT_TYPE, contact_id: CONTACT, booking_date: '2026-10-06', start_time: '10:00' }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  locationRead = { data: { settings: {} }, error: null }
})

describe('POST /api/bookings/create: chat confirmation template (BOOKCHATCOPY.1)', () => {
  it('carries the studio\'s booking confirmation text with the new booking', async () => {
    locationRead = { data: { settings: { customer_agent: { booking_confirmation_text: 'You are in: {class}.' } } }, error: null }
    const r = await create()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ success: true, chat_template: 'You are in: {class}.' })
  })

  it('unset → chat_template null (the panel uses the default)', async () => {
    expect(await (await create()).json()).toMatchObject({ success: true, chat_template: null })
  })

  it('a failed settings read never fails the booking: logged, chat_template null', async () => {
    locationRead = { data: null, error: { message: 'read refused' } }
    const r = await create()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ success: true, data: { id: 'bk-1' }, chat_template: null })
    expect(logWarn).toHaveBeenCalledWith('booking.staff', expect.any(String), expect.objectContaining({ err: 'read refused' }))
  })
})
