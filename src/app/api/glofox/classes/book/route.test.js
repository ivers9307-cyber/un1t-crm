// GLOFOXWRITEJUDGE.1 (b) — the staff Book panel's route judged
// `!ok || success === false`, so Glofox's HTTP 200 YOU_HAVE_BOOKED_FOR_THIS_EVENT
// showed as a red error, and it read the id from body._id / body.data._id,
// never body.Booking (the live success shape), so Undo never appeared.
// createBooking is mocked; interpretBookingResult stays REAL.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOC = 'c0000000-0000-4000-8000-00000000000c'
const CONTACT = 'd0000000-0000-4000-8000-00000000000d'
const MEMBER = 'a'.repeat(24)
const EVENT = 'e'.repeat(24)
const BOOKING = 'b'.repeat(24)
const STAFF = {
  id: 'user-s', isMaster: false, profileRole: 'staff', role: 'manager',
  activeLocation: { id: LOC }, locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' }, permissions: {},
}

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
// contactRead is swapped per test (a failed read); reset in beforeEach.
let contactRead
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: () => {
      const chain = {}
      for (const m of ['select', 'eq']) chain[m] = () => chain
      chain.maybeSingle = async () => contactRead
      return chain
    },
  })),
}))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'br', apiKey: 'k', apiToken: 't', readError: null })),
  createBooking: vi.fn(),
}))

import { getCurrentUser } from '@/lib/auth'
import { createBooking } from '@/lib/glofox'
import { POST } from './route.js'

const book = () => POST(new Request('http://crm.test/api/glofox/classes/book', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ contact_id: CONTACT, event_id: EVENT }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(STAFF)
  contactRead = { data: { id: CONTACT, name: 'Test Person', first_name: 'Test', location_id: LOC, glofox_member_id: MEMBER }, error: null }
})

describe('POST /api/glofox/classes/book', () => {
  it('the live success shape { success, Booking } → success with the booking id (Undo works)', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: BOOKING, status: 'BOOKED' } } })
    const r = await book()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ success: true, glofox_booking_id: BOOKING })
    expect(createBooking).toHaveBeenCalledWith(expect.anything(), { user_id: MEMBER, model: 'event', model_id: EVENT })
  })

  it('HTTP 200 YOU_HAVE_BOOKED_FOR_THIS_EVENT → success, already_booked, no id', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: false, message: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT', message_code: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT' } })
    const r = await book()
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toMatchObject({ success: true, already_booked: true, glofox_booking_id: null })
    expect(j.error).toBeUndefined()
  })

  it('HTTP 200 YOU_HAVE_NO_CREDITS_LEFT → 502 with Glofox\'s words (unchanged)', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const r = await book()
    expect(r.status).toBe(502)
    expect(await r.json()).toMatchObject({ success: false, error: 'YOU_HAVE_NO_CREDITS_LEFT' })
  })

  it('a 200 success:false with no code stays a failure', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: false } })
    const r = await book()
    expect(r.status).toBe(502)
    expect((await r.json()).success).toBe(false)
  })

  it('a C84 recovered booking (landed after a 5xx) → success with the found id', async () => {
    createBooking.mockResolvedValueOnce({ ok: true, status: 200, body: { success: true, Booking: { _id: BOOKING } }, recovered: 'landed_after_5xx' })
    const r = await book()
    expect(await r.json()).toMatchObject({ success: true, glofox_booking_id: BOOKING })
  })

  it('a failed contact read is a 500 saying so, never "Contact not found", and books nothing', async () => {
    contactRead = { data: null, error: { message: 'connection reset' } }
    const r = await book()
    expect(r.status).toBe(500)
    const j = await r.json()
    expect(j.success).toBe(false)
    expect(j.error).not.toMatch(/not found/i)
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('a 503 → 502 with "Glofox booking failed (HTTP 503)" (unchanged)', async () => {
    createBooking.mockResolvedValueOnce({ ok: false, status: 503, body: null })
    const r = await book()
    expect(r.status).toBe(502)
    expect(await r.json()).toMatchObject({ success: false, error: 'Glofox booking failed (HTTP 503)' })
  })
})
