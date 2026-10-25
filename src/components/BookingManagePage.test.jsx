// @vitest-environment jsdom
// BOOKINGSELF.1 — the customer's own booking page (/book/manage/[token]):
// shows the booking, cancels after a confirm, reschedules by day then time,
// and says plainly when it can no longer be changed online.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import BookingManagePage from './BookingManagePage.jsx'

const TOKEN = 'tok.sig'
const BOOKING = {
  id: 'bk1', status: 'confirmed', customer_name: 'Sam Member', event_name: 'Free Consultation',
  studio_name: 'UN1T Stillorgan', studio_address: '1 Main St', duration_minutes: 30, timezone: 'Europe/Dublin',
  booking_date: '2026-10-20', start_time: '10:00', end_time: '10:30', when_label: 'Tue, 20 Oct, 10:00',
  can_cancel: true, can_reschedule: true, blocked_reason: null, reschedule_note: null,
  available_days: [{ date: '2026-10-21', label: 'Wed, 21 Oct' }, { date: '2026-10-22', label: 'Thu, 22 Oct' }],
}

function stubFetch(handlers) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null })
    const h = handlers[`${method} ${url}`]
    const r = typeof h === 'function' ? h(calls) : h
    if (!r) throw new Error(`unexpected ${method} ${url}`)
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  }))
  return calls
}
const ok = (data) => ({ status: 200, body: { success: true, data } })
const BASE = `/api/public/booking-manage/${TOKEN}`

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BookingManagePage', () => {
  it('shows the booking with both actions', async () => {
    stubFetch({ [`GET ${BASE}`]: ok(BOOKING) })
    render(<BookingManagePage token={TOKEN} />)
    await screen.findByText('Free Consultation')
    expect(screen.getByText(/Tue, 20 Oct, 10:00/)).toBeTruthy()
    expect(screen.getByText(/UN1T Stillorgan, 1 Main St/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeTruthy()
  })

  it('cancels only after the confirm, then shows it cancelled', async () => {
    let loads = 0
    const calls = stubFetch({
      [`GET ${BASE}`]: () => (++loads === 1 ? ok(BOOKING) : ok({ ...BOOKING, status: 'cancelled', can_cancel: false, can_reschedule: false, blocked_reason: 'This booking has been cancelled.' })),
      [`POST ${BASE}/cancel`]: ok({ cancelled: true }),
    })
    render(<BookingManagePage token={TOKEN} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }))
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }))
    await screen.findByText('Your booking has been cancelled.')
    expect(screen.getByText('Cancelled')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
  })

  it('reschedules: day, then time, then the move; posts only date + time', async () => {
    let loads = 0
    const calls = stubFetch({
      [`GET ${BASE}`]: () => (++loads === 1 ? ok(BOOKING) : ok({ ...BOOKING, booking_date: '2026-10-22', when_label: 'Thu, 22 Oct, 11:00' })),
      [`GET ${BASE}/slots?date=2026-10-22`]: ok({ date: '2026-10-22', slots: [{ start: '10:30', end: '11:00' }, { start: '11:00', end: '11:30' }] }),
      [`POST ${BASE}/reschedule`]: ok({ rescheduled: true }),
    })
    render(<BookingManagePage token={TOKEN} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }))
    fireEvent.click(screen.getByRole('button', { name: 'Thu, 22 Oct' }))
    fireEvent.click(await screen.findByRole('button', { name: '11:00' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move to Thu, 22 Oct, 11:00' }))
    await screen.findByText('Your booking has been moved.')
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ booking_date: '2026-10-22', start_time: '11:00' })
    expect(screen.getByText(/Thu, 22 Oct, 11:00/)).toBeTruthy()
  })

  it('shows the server sentence when the slot was taken meanwhile', async () => {
    stubFetch({
      [`GET ${BASE}`]: ok(BOOKING),
      [`GET ${BASE}/slots?date=2026-10-21`]: ok({ date: '2026-10-21', slots: [{ start: '09:00', end: '09:30' }] }),
      [`POST ${BASE}/reschedule`]: { status: 409, body: { success: false, error: 'slot_unavailable', message: 'That time is no longer available. Please pick another.' } },
    })
    render(<BookingManagePage token={TOKEN} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }))
    fireEvent.click(screen.getByRole('button', { name: 'Wed, 21 Oct' }))
    fireEvent.click(await screen.findByRole('button', { name: '09:00' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move to Wed, 21 Oct, 09:00' }))
    await screen.findByText('That time is no longer available. Please pick another.')
  })

  it('inside the cut-off: the reason, and no actions', async () => {
    stubFetch({ [`GET ${BASE}`]: ok({ ...BOOKING, can_cancel: false, can_reschedule: false, available_days: [],
      blocked_reason: 'This booking can no longer be changed online. Please contact UN1T Stillorgan.' }) })
    render(<BookingManagePage token={TOKEN} />)
    await screen.findByText('This booking can no longer be changed online. Please contact UN1T Stillorgan.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a bad link shows the server sentence', async () => {
    stubFetch({ [`GET ${BASE}`]: { status: 404, body: { success: false, error: 'not_found', message: 'This link is not valid or has expired.' } } })
    render(<BookingManagePage token={TOKEN} />)
    await waitFor(() => expect(screen.getByText('This link is not valid or has expired.')).toBeTruthy())
  })
})
