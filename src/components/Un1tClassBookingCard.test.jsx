// @vitest-environment jsdom
//
// UN1TWRITE.15 — the un1t.online booking card on the contact page.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
import Un1tClassBookingCard from './Un1tClassBookingCard.jsx'

const LOC = 'loc-hatch'
let payload
let calls
beforeEach(() => {
  calls = []
  payload = {
    classes: [],
    credits: { balance: 3, unlimited: false, as_of: '2026-10-18T08:00:00.000Z' },
    upcoming: [{ booking_id: 'bk-7', event_id: 'ev-7', name: 'RALLY', starts_at: new Date(Date.now() + 86_400_000).toISOString() }],
  }
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    const json = (o) => new Response(JSON.stringify(o), { status: 200 })
    if (u.startsWith('/api/un1t-online/classes/cancel')) return json({ success: true, data: { un1t_booking_id: 'bk-7' } })
    if (u.startsWith('/api/un1t-online/classes')) return json({ success: true, data: payload })
    return json({ success: false })
  })
})
afterEach(() => cleanup())

const mount = () => render(<Un1tClassBookingCard contactId="c1" locationId={LOC} studioName="Hatch Street" waConversationId={null} waWindowOpen={false} />)

describe('Un1tClassBookingCard', () => {
  it('shows the credits line with its as-of, and the upcoming list with Cancel', async () => {
    mount()
    expect(await screen.findByText(/Credits: 3/)).toBeTruthy()
    expect(screen.getByText(/Upcoming at Hatch Street/)).toBeTruthy()
    expect(screen.getByText(/RALLY/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/un1t-online/classes/cancel'))).toBe(true))
    expect(calls.find((c) => c.url.startsWith('/api/un1t-online/classes/cancel')).body).toEqual({ contact_id: 'c1', location_id: LOC, booking_id: 'bk-7' })
  })

  it('unlimited, and no credits', async () => {
    payload.credits = { balance: null, unlimited: true, as_of: null }
    mount()
    expect(await screen.findByText(/Unlimited/)).toBeTruthy()
    cleanup()
    payload.credits = { balance: 0, unlimited: false, as_of: null }
    mount()
    expect(await screen.findByText('No credits: un1t.online will refuse unless they hold a membership')).toBeTruthy()
  })
})
