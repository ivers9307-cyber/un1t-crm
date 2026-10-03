// @vitest-environment jsdom
//
// BOOKCHATCOPY.1 (C111) — the line the staff Book panel drops into the open
// chat after a booking is customer copy. It was hard-coded as
// "✅ Booked into X — time" / "✅ Booked: X — date at time" (an emoji and
// em-dashes). It is now the studio's editable booking confirmation, which the
// booking routes hand back as chat_template, falling back to a plain default.
// Ids are synthetic.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import BookPanel from './BookPanel.jsx'

const EMOJI = /\p{Extended_Pictographic}/u
const CLASS = { id: 'ev1', name: 'HIIT', time_start_ms: Date.now() + 3 * 3600 * 1000 }
const EVENT_TYPES = [{
  id: 'et1', name: 'Consultation', slug: 'consult', duration_minutes: 30,
  availability: { sun: true, mon: true, tue: true, wed: true, thu: true, fri: true, sat: true },
}]

let sent
let bookReply
let classes
beforeEach(() => {
  sent = []
  bookReply = { success: true, glofox_booking_id: 'b1', chat_template: null }
  classes = [CLASS]
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    const json = (o) => new Response(JSON.stringify(o), { status: 200 })
    if (u.startsWith('/api/glofox/classes/book')) return json(bookReply)
    if (u.startsWith('/api/glofox/classes')) return json({ success: true, classes })
    if (u.startsWith('/api/public/bookings/consult/slots')) return json({ success: true, data: { slots: [{ start: '10:00' }] } })
    if (u.startsWith('/api/bookings/create')) return json({ success: true, data: { id: 'bk1' }, confirmation: null, chat_template: bookReply.chat_template })
    if (u.includes('/send')) { sent.push(JSON.parse(init.body).text); return json({ success: true }) }
    return json({ success: false })
  })
})
afterEach(() => cleanup())

const renderPanel = () => render(
  <BookPanel contactId="c1" locationId="l1" glofoxMemberId="m1" eventTypes={EVENT_TYPES} channel="wa" conversationId="conv1" />
)

function expectPlain(text) {
  expect(text).not.toMatch(/[—–]/)
  expect(text).not.toMatch(EMOJI)
}

describe('BookPanel chat confirmation (BOOKCHATCOPY.1)', () => {
  it('a class booking sends the plain default when the studio has not set one', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Book' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatch(/^Good news, you're booked in for HIIT, .+\. See you there\.$/)
    expectPlain(sent[0])
  })

  it('a class booking sends the studio\'s own text when set', async () => {
    bookReply = { ...bookReply, chat_template: 'You are in: {class}.' }
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Book' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatch(/^You are in: HIIT, .+\.$/)
  })

  it('a consultation booking sends the plain default too', async () => {
    classes = []
    renderPanel()
    await screen.findByText('No upcoming classes found.')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'et1' } })
    const dayButtons = screen.getAllByRole('button')
    fireEvent.click(dayButtons[0])
    fireEvent.click(await screen.findByRole('button', { name: '10:00am' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatch(/^Good news, you're booked in for Consultation, .+ at 10:00am\. See you there\.$/)
    expectPlain(sent[0])
  })
})
