// @vitest-environment jsdom
//
// UN1TWRITE.15 — BookPanel's classProvider: 'un1t_online' calls the un1t.online
// staff routes with location_id; the default stays on Glofox, unchanged.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import BookPanel from './BookPanel.jsx'

const LOC = 'loc-hatch'
const UN1T_CLASS = { id: 'ev-1', name: 'RALLY', starts_at: new Date(Date.now() + 3 * 3600_000).toISOString(), day: 'Mon 20 Oct', time: '18:00', spots_left: 4, community: false }
let calls
beforeEach(() => {
  calls = []
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    const json = (o) => new Response(JSON.stringify(o), { status: 200 })
    if (u.startsWith('/api/un1t-online/classes/book')) return json({ success: true, data: { un1t_booking_id: 'bk-1', already_booked: false } })
    if (u.startsWith('/api/un1t-online/classes/cancel')) return json({ success: true, data: { un1t_booking_id: 'bk-1' } })
    if (u.startsWith('/api/un1t-online/classes')) return json({ success: true, data: { classes: [UN1T_CLASS], credits: { balance: 1, unlimited: false, as_of: null }, upcoming: [] } })
    if (u.startsWith('/api/glofox/classes')) return json({ success: true, classes: [] })
    return json({ success: false })
  })
})
afterEach(() => cleanup())

describe('BookPanel classProvider', () => {
  it('un1t_online lists, books and undoes through the un1t endpoints with location_id', async () => {
    const onLoaded = vi.fn()
    render(<BookPanel contactId="c1" locationId={LOC} eventTypes={[]} classProvider="un1t_online" onClassesLoaded={onLoaded} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Book' }))
    await screen.findByText(/Booked into RALLY/)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/un1t-online/classes/cancel'))).toBe(true))
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(['/api/un1t-online/classes', '/api/un1t-online/classes/book', '/api/un1t-online/classes/cancel'])
    expect(calls[0].url).toBe(`/api/un1t-online/classes?location_id=${LOC}&contact_id=c1`)
    expect(calls[1].body).toEqual({ contact_id: 'c1', location_id: LOC, event_id: 'ev-1' })
    expect(calls[2].body).toEqual({ contact_id: 'c1', location_id: LOC, booking_id: 'bk-1' })
    expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ credits: expect.any(Object) }))
    expect(screen.queryByText(/Not linked to a Glofox member/)).toBeNull()
  })

  it('the default still calls /api/glofox/classes and nothing else', async () => {
    render(<BookPanel contactId="c1" locationId={LOC} eventTypes={[{ id: 'et', name: 'X', slug: 'x', duration_minutes: 30, availability: {} }]} />)
    await screen.findByText(/No upcoming classes found/)
    expect(calls.map((c) => c.url)).toEqual([`/api/glofox/classes?location_id=${LOC}`])
  })
})
