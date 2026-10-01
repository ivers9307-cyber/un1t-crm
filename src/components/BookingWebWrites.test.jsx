// @vitest-environment jsdom
//
// C134 WEBBOOKINGWRITES.1 — the /bookings status pill and reminder bell wrote
// `bookings` through the browser client and never read the answer, so a
// refused write (RLS judged the PHONE key) looked like it worked. They now
// call the service-role routes, and a failure puts the old value back and
// says so.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
// Neither component may touch the browser client any more.
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => { throw new Error('browser client used') } }))

import BookingStatusToggle from './BookingStatusToggle'
import BookingSkipReminderToggle from './BookingSkipReminderToggle'

let calls
let answer
beforeEach(() => {
  calls = []
  refresh.mockClear()
  answer = { ok: true, status: 200, body: { success: true } }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null })
    if (answer instanceof Error) throw answer
    return { ok: answer.ok, status: answer.status, json: async () => answer.body }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BookingStatusToggle (C134)', () => {
  const pick = (label) => {
    fireEvent.click(screen.getByRole('button', { name: 'confirmed' }))
    fireEvent.click(screen.getByRole('button', { name: label }))
  }

  it('posts the new status to the route and refreshes', async () => {
    render(<BookingStatusToggle bookingId="bk-1" currentStatus="confirmed" />)
    pick('completed')
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(calls).toEqual([{ url: '/api/bookings/bk-1/status', method: 'POST', body: { status: 'completed' } }])
    expect(screen.getByRole('button', { name: 'completed' })).toBeTruthy()
  })

  it('a refusal puts the old status back and shows the route\'s error', async () => {
    answer = { ok: false, status: 403, body: { success: false, error: 'No bookings permission at this location' } }
    render(<BookingStatusToggle bookingId="bk-1" currentStatus="confirmed" />)
    pick('no show')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No bookings permission at this location'))
    expect(screen.getByRole('button', { name: 'confirmed' })).toBeTruthy()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a network failure puts the old status back and says so', async () => {
    answer = new Error('Failed to fetch')
    render(<BookingStatusToggle bookingId="bk-1" currentStatus="confirmed" />)
    pick('completed')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not change the booking status/i))
    expect(screen.getByRole('button', { name: 'confirmed' })).toBeTruthy()
  })

  it('without canEdit it is a plain label: no menu, no write', () => {
    render(<BookingStatusToggle bookingId="bk-1" currentStatus="confirmed" canEdit={false} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('confirmed')).toBeTruthy()
  })
})

describe('BookingSkipReminderToggle (C134)', () => {
  const props = { bookingId: 'bk-1', skipReminder: false, reminderSentAt: null, bookingDate: '2999-01-01' }

  it('posts the flag to the route and refreshes', async () => {
    render(<BookingSkipReminderToggle {...props} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(calls).toEqual([{ url: '/api/bookings/bk-1/skip-reminder', method: 'POST', body: { skip_reminder: true } }])
  })

  it('a refusal puts the bell back and shows the error', async () => {
    answer = { ok: false, status: 403, body: { success: false, error: 'No bookings permission at this location' } }
    render(<BookingSkipReminderToggle {...props} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No bookings permission'))
    expect(screen.getByRole('button').getAttribute('title')).toMatch(/^Reminder enabled/)
    expect(refresh).not.toHaveBeenCalled()
  })
})
