// @vitest-environment jsdom
//
// EVENTTYPERLS.1 — the booking-type form saves through the guarded routes
// (POST /api/bookings/event-types, PUT /api/bookings/event-types/[id]),
// never with the browser Supabase client: RLS let ANY member of the studio
// write event_types that way, and mig 650 removes the browser write entirely.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const { router, browserClient } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn(), back: vi.fn() },
  browserClient: vi.fn(() => { throw new Error('EventForm must not use the browser Supabase client') }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: browserClient }))

import EventForm from './EventForm.jsx'

// fetch fake: answers by "METHOD url"; records every call with its parsed body.
let calls
function answer(routes) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined })
    const r = routes[key]
    if (!r) throw new Error(`unexpected fetch ${key}`)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }
  }))
}
const keys = () => calls.map((c) => c.key)
const bodyOf = (key) => calls.find((c) => c.key === key)?.body

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EventForm — saves through the routes (EVENTTYPERLS.1)', () => {
  it('create: POSTs the booking type with its studio, then syncs reminders, then leaves', async () => {
    answer({
      'POST /api/bookings/event-types': { body: { success: true, data: { id: 'et-new' } } },
      'PUT /api/bookings/event-types/et-new/reminders': { body: { success: true, data: [] } },
    })
    const { container } = render(<EventForm locationId="loc-1" />)
    fireEvent.change(screen.getByPlaceholderText('e.g. Free Consultation'), { target: { value: 'Free Consultation' } })
    fireEvent.submit(container.querySelector('form'))

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/bookings/event-types'))
    expect(keys()).toEqual(['POST /api/bookings/event-types', 'PUT /api/bookings/event-types/et-new/reminders'])
    const sent = bodyOf('POST /api/bookings/event-types')
    expect(sent).toMatchObject({
      name: 'Free Consultation',
      location_id: 'loc-1',
      duration_minutes: 30,
      active: true,
      confirmation_enabled: false,
      confirmation_channels: null,
      create_in_glofox: false,
    })
    expect('slug' in sent).toBe(false) // the routes derive it from the name
    expect(bodyOf('PUT /api/bookings/event-types/et-new/reminders')).toEqual({ reminders: [] })
    expect(browserClient).not.toHaveBeenCalled()
  })

  it('edit: PUTs to the row (no location_id), confirmation fields included', async () => {
    answer({
      'GET /api/bookings/event-types/et-1/reminders': { body: { success: true, data: [] } },
      'PUT /api/bookings/event-types/et-1': { body: { success: true, data: { id: 'et-1' } } },
      'PUT /api/bookings/event-types/et-1/reminders': { body: { success: true, data: [] } },
    })
    const event = {
      id: 'et-1', name: 'Consult', location_id: 'loc-1', duration_minutes: 45,
      confirmation_enabled: true, confirmation_channels: ['sms'], confirmation_sms_body: 'See you',
    }
    const { container } = render(<EventForm event={event} locationId="loc-1" />)
    fireEvent.submit(container.querySelector('form'))

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/bookings/event-types'))
    const sent = bodyOf('PUT /api/bookings/event-types/et-1')
    expect(sent).toMatchObject({
      name: 'Consult',
      duration_minutes: 45,
      confirmation_enabled: true,
      confirmation_channels: ['sms'],
      confirmation_sms_body: 'See you',
      confirmation_email_subject: null,
    })
    expect('location_id' in sent).toBe(false)
    expect(keys()).toContain('PUT /api/bookings/event-types/et-1/reminders')
    expect(browserClient).not.toHaveBeenCalled()
  })

  it('a refused save says so, syncs no reminders and stays on the page', async () => {
    answer({ 'POST /api/bookings/event-types': { status: 401, body: { success: false, error: 'Unauthorized' } } })
    const { container } = render(<EventForm locationId="loc-1" />)
    fireEvent.change(screen.getByPlaceholderText('e.g. Free Consultation'), { target: { value: 'Consult' } })
    fireEvent.submit(container.querySelector('form'))

    expect(await screen.findByText("You can't create or edit booking types at this studio.")).toBeTruthy()
    expect(keys()).toEqual(['POST /api/bookings/event-types'])
    expect(router.push).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create event type' }).disabled).toBe(false)
  })

  it('a validation refusal names the field', async () => {
    answer({
      'POST /api/bookings/event-types': {
        status: 400,
        body: { success: false, error: 'Invalid request body', issues: [{ path: 'webhook_url', message: 'Invalid URL' }] },
      },
    })
    const { container } = render(<EventForm locationId="loc-1" />)
    fireEvent.change(screen.getByPlaceholderText('e.g. Free Consultation'), { target: { value: 'Consult' } })
    fireEvent.submit(container.querySelector('form'))

    expect(await screen.findByText('Could not save: webhook_url: Invalid URL')).toBeTruthy()
    expect(router.push).not.toHaveBeenCalled()
  })
})
