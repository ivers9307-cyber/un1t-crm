// UN1TWRITE.15 — what the staff Book panel says after a un1t.online booking.
import { describe, it, expect } from 'vitest'
import { un1tClassBookResultView } from './un1t-class-book-result'

describe('un1tClassBookResultView', () => {
  it('success, already booked, refusal words, unknown copy', () => {
    expect(un1tClassBookResultView({ success: true, data: { un1t_booking_id: 'bk-1', already_booked: false } }, 'RALLY'))
      .toEqual({ ok: true, message: 'Booked into RALLY.', sendChat: true, bookingId: 'bk-1' })
    expect(un1tClassBookResultView({ success: true, data: { un1t_booking_id: 'bk-1', already_booked: true } }, 'RALLY'))
      .toEqual({ ok: true, message: 'Already booked in un1t.online', sendChat: false, bookingId: null })
    expect(un1tClassBookResultView({ success: false, error: 'No credits left', code: 'NO_CREDITS' }, 'RALLY'))
      .toEqual({ ok: false, message: 'No credits left', sendChat: false, bookingId: null })
    expect(un1tClassBookResultView({ success: false, code: 'outcome_unknown', error: 'un1t.online did not answer clearly. Check the class in un1t.online before trying again.' }, 'RALLY').message)
      .toBe('un1t.online did not answer clearly. Check the class in un1t.online before trying again.')
    expect(un1tClassBookResultView({}, 'RALLY').message).toBe('un1t.online did not answer clearly. Check the class in un1t.online before trying again.')
  })
})
