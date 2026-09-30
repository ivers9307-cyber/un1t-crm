// GLOFOXWRITEJUDGE.1 (b) — what the staff Book panel shows after
// /api/glofox/classes/book. The decision lives here (pure) because the panel
// has no component test.
import { describe, it, expect } from 'vitest'
import { classBookResultView } from './glofox-class-book-result.js'

describe('classBookResultView', () => {
  it('a booking: green, the chat line goes, Undo gets the id', () => {
    expect(classBookResultView({ success: true, glofox_booking_id: 'bk1' }, 'SQUAD')).toEqual({
      ok: true, message: 'Booked into SQUAD.', sendChat: true, bookingId: 'bk1',
    })
  })

  it('already booked: green, says nothing new was booked, NO chat line, no Undo', () => {
    const v = classBookResultView({ success: true, already_booked: true, glofox_booking_id: null }, 'SQUAD')
    expect(v).toMatchObject({ ok: true, sendChat: false, bookingId: null })
    expect(v.message).toBe('Already booked into SQUAD in Glofox. Nothing new was booked and no chat message was sent.')
  })

  it('a failure: red, Glofox\'s words, no chat line', () => {
    expect(classBookResultView({ success: false, error: 'YOU_HAVE_NO_CREDITS_LEFT' }, 'SQUAD')).toEqual({
      ok: false, message: 'YOU_HAVE_NO_CREDITS_LEFT', sendChat: false, bookingId: null,
    })
    expect(classBookResultView({}, 'SQUAD').message).toBe('Glofox booking failed')
    expect(classBookResultView(null, 'SQUAD').ok).toBe(false)
  })

  it('no em-dashes in anything it says', () => {
    for (const d of [{ success: true }, { success: true, already_booked: true }, { success: false }]) {
      expect(classBookResultView(d, 'X').message).not.toMatch(/—/)
    }
  })
})
