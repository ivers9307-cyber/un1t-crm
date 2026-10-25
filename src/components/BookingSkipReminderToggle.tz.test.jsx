// @vitest-environment jsdom
//
// TZ.7 — the reminder bell hides for a booking whose date has passed on the
// STUDIO's clock (the `zone` prop the bookings page passes), not Dublin's.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import BookingSkipReminderToggle from './BookingSkipReminderToggle'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const props = { bookingId: 'bk-1', skipReminder: false, reminderSentAt: null }
const at = (iso) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
}

describe('BookingSkipReminderToggle — studio zone (TZ.7)', () => {
  it('Europe/Dublin: hides a booking dated before the Dublin day, as before', () => {
    at('2026-03-08T04:30:00Z') // Sun 8 Mar in Dublin
    const { container } = render(<BookingSkipReminderToggle {...props} bookingDate="2026-03-07" zone="Europe/Dublin" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('no zone prop is Dublin, as before', () => {
    at('2026-03-08T04:30:00Z')
    const { container } = render(<BookingSkipReminderToggle {...props} bookingDate="2026-03-07" />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('America/New_York: the same instant is still Sat 7 Mar there, so the bell shows', () => {
    at('2026-03-08T04:30:00Z') // 23:30 Sat 7 Mar EST
    const { container } = render(<BookingSkipReminderToggle {...props} bookingDate="2026-03-07" zone="America/New_York" />)
    expect(container.querySelector('button')).not.toBeNull()
  })

  it('America/New_York after its fall-back midnight: Sat 31 Oct is past', () => {
    at('2026-11-01T04:30:00Z') // 00:30 Sun 1 Nov EDT
    const { container } = render(<BookingSkipReminderToggle {...props} bookingDate="2026-10-31" zone="America/New_York" />)
    expect(container.querySelector('button')).toBeNull()
  })
})
