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
    if (u.startsWith('/api/un1t-online/classes/move')) return json({ success: true, data: { un1t_booking_id: 'bk-7' } })
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

  it('a booking keeps the panel (its result line and Undo stay) and refreshes the upcoming list', async () => {
    payload.classes = [{ id: 'ev-1', name: 'BASE', starts_at: new Date(Date.now() + 7_200_000).toISOString(), spots_left: 5, community: false }]
    global.fetch.mockImplementation(async (url, init) => {
      const u = String(url)
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
      const json = (o) => new Response(JSON.stringify(o), { status: 200 })
      if (u.startsWith('/api/un1t-online/classes/book')) return json({ success: true, data: { un1t_booking_id: 'bk-9', already_booked: false, chat_template: null } })
      if (u.startsWith('/api/un1t-online/classes')) return json({ success: true, data: payload })
      return json({ success: false })
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Book' }))
    expect(await screen.findByText(/Booked into BASE/)).toBeTruthy()
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/un1t-online/classes?')).length).toBe(2))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('UN1TMOVE.1: Move offers the other classes and sends one move for the booking, then refreshes the list', async () => {
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString()
    payload.classes = [
      { id: 'ev-7', name: 'RALLY', starts_at: payload.upcoming[0].starts_at, day: 'Thu 30 Oct', time: '07:00', spots_left: 3, community: false },
      { id: 'ev-8', name: 'BASE', starts_at: later, day: 'Fri 31 Oct', time: '09:00', spots_left: 0, community: false },
      { id: 'ev-9', name: 'ENGINE', starts_at: later, day: 'Fri 31 Oct', time: '18:00', spots_left: 4, community: false },
    ]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    const select = screen.getByRole('combobox', { name: /Move RALLY to/ })
    const options = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)
    // Never the class it is already in.
    expect(options).toEqual(['ev-8', 'ev-9'])
    const moveHere = screen.getByRole('button', { name: 'Move here' })
    expect(moveHere.disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'ev-9' } })
    fireEvent.click(moveHere)
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/un1t-online/classes/move'))).toBe(true))
    expect(calls.find((c) => c.url.startsWith('/api/un1t-online/classes/move')).body).toEqual({ contact_id: 'c1', location_id: LOC, booking_id: 'bk-7', event_id: 'ev-9' })
    expect(await screen.findByText('Booking moved in un1t.online.')).toBeTruthy()
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/un1t-online/classes?')).length).toBe(2))
  })

  it('UN1TMOVE.2: with an open WhatsApp window, a done move sends the studio\'s moved text into the thread (from the old class to the new)', async () => {
    payload.classes = [{ id: 'ev-9', name: 'ENGINE', starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), day: 'Fri 31 Oct', time: '18:00', spots_left: 4, community: false }]
    global.fetch.mockImplementation(async (url, init) => {
      const u = String(url)
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
      const json = (o) => new Response(JSON.stringify(o), { status: 200 })
      if (u.startsWith('/api/un1t-online/classes/move')) return json({ success: true, data: { un1t_booking_id: 'bk-7', chat_template: 'Now {to}, not {from}.' } })
      if (u.startsWith('/api/whatsapp/conversations/wa-1/send')) return json({ success: true })
      return json({ success: true, data: payload })
    })
    render(<Un1tClassBookingCard contactId="c1" locationId={LOC} studioName="Hatch Street" waConversationId="wa-1" waWindowOpen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    fireEvent.change(screen.getByRole('combobox', { name: /Move RALLY to/ }), { target: { value: 'ev-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }))
    expect(await screen.findByText(/Booking moved in un1t\.online\. Message sent in the chat\./)).toBeTruthy()
    const sent = calls.find((c) => c.url === '/api/whatsapp/conversations/wa-1/send')
    expect(sent.body.text).toMatch(/^Now ENGINE, Fri 31 Oct 18:00, not RALLY, /)
  })

  it('UN1TMOVE.2: a failed send never undoes the move; with no WhatsApp thread nothing is sent', async () => {
    payload.classes = [{ id: 'ev-9', name: 'ENGINE', starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), day: 'Fri', time: '18:00', spots_left: 4, community: false }]
    global.fetch.mockImplementation(async (url, init) => {
      const u = String(url)
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
      const json = (o) => new Response(JSON.stringify(o), { status: 200 })
      if (u.startsWith('/api/un1t-online/classes/move')) return json({ success: true, data: { un1t_booking_id: 'bk-7', chat_template: null } })
      if (u.includes('/send')) return json({ success: false, error: 'window closed' })
      return json({ success: true, data: payload })
    })
    render(<Un1tClassBookingCard contactId="c1" locationId={LOC} studioName="Hatch Street" waConversationId="wa-1" waWindowOpen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    fireEvent.change(screen.getByRole('combobox', { name: /Move RALLY to/ }), { target: { value: 'ev-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }))
    expect(await screen.findByText(/Booking moved in un1t\.online\. The chat message did not send \(window closed\)\./)).toBeTruthy()
    cleanup()
    calls = []
    mount() // no WhatsApp thread
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    fireEvent.change(screen.getByRole('combobox', { name: /Move RALLY to/ }), { target: { value: 'ev-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }))
    expect(await screen.findByText('Booking moved in un1t.online.')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false)
  })

  it('UN1TMOVE.1: a refused move shows its words and moves nothing', async () => {
    payload.classes = [{ id: 'ev-8', name: 'BASE', starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), day: 'Fri', time: '09:00', spots_left: 0, community: false }]
    global.fetch.mockImplementation(async (url, init) => {
      const u = String(url)
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
      if (u.startsWith('/api/un1t-online/classes/move')) return new Response(JSON.stringify({ success: false, error: 'This class is full' }), { status: 409 })
      return new Response(JSON.stringify({ success: true, data: payload }), { status: 200 })
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }))
    fireEvent.change(screen.getByRole('combobox', { name: /Move RALLY to/ }), { target: { value: 'ev-8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }))
    expect(await screen.findByText('This class is full')).toBeTruthy()
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
