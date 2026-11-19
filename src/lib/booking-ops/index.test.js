// BOOKINGOPS.1 — one answer shape for a booking, whichever platform.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async () => {
  const actual = await vi.importActual('@/lib/glofox')
  return { ...actual, createBooking: vi.fn(), cancelBooking: vi.fn() }
})
vi.mock('@/lib/un1t-online-write-ops', () => ({ book: vi.fn(), cancel: vi.fn(), moveBooking: vi.fn() }))

import { createBooking, cancelBooking } from '@/lib/glofox'
import { book, cancel } from '@/lib/un1t-online-write-ops'
import { bookingOpsFor, BOOKING_PLATFORMS } from './index.js'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
beforeEach(() => vi.clearAllMocks())

describe('bookingOpsFor', () => {
  it('knows both platforms and refuses any other', () => {
    expect(BOOKING_PLATFORMS).toEqual(['glofox', 'un1t_online'])
    expect(() => bookingOpsFor('none')).toThrow(/no booking platform/)
    expect(bookingOpsFor('glofox').canMove).toBe(false)
    expect(bookingOpsFor('un1t_online').canMove).toBe(true)
  })
})

describe('Glofox book', () => {
  const run = () => bookingOpsFor('glofox').book({ creds }, { glofoxMemberId: 'm1', eventId: 'e1' })

  it('a booking with an id is done', async () => {
    createBooking.mockResolvedValue({ ok: true, status: 200, body: { success: true, Booking: { _id: 'bk1' } } })
    expect(await run()).toMatchObject({ verdict: 'done', id: 'bk1', alreadyBooked: false })
    expect(createBooking.mock.calls[0][1]).toMatchObject({ user_id: 'm1', model_id: 'e1' })
  })

  it('a 200 with a failure body is refused, with Glofox\'s code', async () => {
    createBooking.mockResolvedValue({ ok: true, status: 200, body: { success: false, message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    expect(await run()).toMatchObject({ verdict: 'refused', code: 'YOU_HAVE_NO_CREDITS_LEFT', retryable: false })
  })

  it('"already booked" is done, not refused', async () => {
    createBooking.mockResolvedValue({ ok: true, status: 200, body: { success: false, message_code: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT' } })
    expect(await run()).toMatchObject({ verdict: 'done', id: null, alreadyBooked: true })
  })

  it('an HTTP failure is refused with its status', async () => {
    createBooking.mockResolvedValue({ ok: false, status: 503, body: {} })
    expect(await run()).toMatchObject({ verdict: 'refused', code: 'status_503' })
  })
})

describe('Glofox cancel', () => {
  const run = () => bookingOpsFor('glofox').cancel({ creds }, { glofoxMemberId: 'm1', bookingId: 'bk1' })

  it('a success is done', async () => {
    cancelBooking.mockResolvedValue({ ok: true, status: 200, body: { success: true } })
    expect(await run()).toMatchObject({ verdict: 'done', id: 'bk1' })
    expect(cancelBooking).toHaveBeenCalledWith(creds, 'bk1', 'm1')
  })

  it('a late-cancel rule (200, success:false) is refused with Glofox\'s words', async () => {
    cancelBooking.mockResolvedValue({ ok: true, status: 200, body: { success: false, message: 'Too late to cancel' } })
    expect(await run()).toMatchObject({ verdict: 'refused', message: 'Too late to cancel' })
  })
})

describe('un1t.online', () => {
  it('passes book and cancel through to the write primitives, which already answer in this shape', async () => {
    const db = {}
    const deps = { x: 1 }
    book.mockResolvedValue({ verdict: 'done', id: 'u1' })
    cancel.mockResolvedValue({ verdict: 'refused', code: 'writes_off' })
    const ops = bookingOpsFor('un1t_online')
    expect(await ops.book({ db, deps }, { eventId: 'e' })).toEqual({ verdict: 'done', id: 'u1' })
    expect(book).toHaveBeenCalledWith(db, { eventId: 'e' }, deps)
    expect(await ops.cancel({ db }, { bookingId: 'b' })).toEqual({ verdict: 'refused', code: 'writes_off' })
    expect(cancel).toHaveBeenCalledWith(db, { bookingId: 'b' }, undefined)
  })
})
