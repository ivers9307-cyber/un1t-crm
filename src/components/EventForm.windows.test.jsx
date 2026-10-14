// @vitest-environment jsdom
//
// BOOKINGWINDOWS.1 — the booking-type form edits several availability
// windows per day, saves every open day as a list, and refuses overlapping
// or backwards windows before anything is sent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), refresh: vi.fn(), back: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => { throw new Error('no browser client') } }))

import EventForm from './EventForm.jsx'

let calls
beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ key: `${init.method || 'GET'} ${url}`, body: init.body ? JSON.parse(init.body) : undefined })
    if (String(url).endsWith('/reminders')) return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
    if (String(url).includes('/api/bookings/event-types')) return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'et1' } }) }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// A row saved before multiple windows existed: one { start, end } per day.
const legacyEvent = {
  id: 'et1', name: 'Consultation', duration_minutes: 30, buffer_minutes: 0, max_advance_days: 30,
  availability: { mon: { start: '09:00', end: '12:00' }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
  custom_fields: [],
}
const saved = () => calls.find((c) => c.key === 'PUT /api/bookings/event-types/et1')?.body

describe('EventForm availability windows (BOOKINGWINDOWS.1)', () => {
  it('adds a second window to a day and saves every open day as a list', async () => {
    const { container } = render(<EventForm event={legacyEvent} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a window on Monday' }))
    fireEvent.change(screen.getByLabelText('Monday window 2 start'), { target: { value: '17:00' } })
    fireEvent.change(screen.getByLabelText('Monday window 2 end'), { target: { value: '20:00' } })
    fireEvent.submit(container.querySelector('form'))

    await waitFor(() => expect(saved()).toBeDefined())
    expect(saved().availability).toEqual({
      mon: [{ start: '09:00', end: '12:00' }, { start: '17:00', end: '20:00' }],
      tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
    })
  })

  it('refuses overlapping windows inline and sends nothing', async () => {
    const { container } = render(<EventForm event={legacyEvent} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a window on Monday' }))
    fireEvent.change(screen.getByLabelText('Monday window 2 start'), { target: { value: '11:00' } })
    fireEvent.change(screen.getByLabelText('Monday window 2 end'), { target: { value: '13:00' } })

    expect(screen.getAllByText('09:00–12:00 overlaps 11:00–13:00.').length).toBeGreaterThan(0)
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText('Could not save: Monday: 09:00–12:00 overlaps 11:00–13:00.')).toBeTruthy()
    expect(calls.filter((c) => c.key.startsWith('PUT') || c.key.startsWith('POST'))).toEqual([])
  })

  it('removing the last window turns the day off', async () => {
    const { container } = render(<EventForm event={legacyEvent} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Monday window 1' }))
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(saved()).toBeDefined())
    expect(saved().availability.mon).toBeNull()
  })
})
