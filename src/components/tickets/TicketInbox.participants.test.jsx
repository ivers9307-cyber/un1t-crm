// @vitest-environment jsdom
//
// EMAIL-PARTICIPANTS.7 — the client half of the participants contract.
//
// patchParticipants() is the ONLY place the browser expresses that contract:
// the URL, the { remove: [address] } / { restore: [address] } body, and what
// happens to the chip when the write does not land. A wrong URL or a wrong key
// fails in exactly the shape this programme keeps finding — the button appears
// to work, the audience never changes, and the next reply reaches a set nobody
// chose. None of that is visible without a test that actually clicks the chip.
//
// Deliberately narrow: three behaviours through the real TicketInbox, using the
// mock-fetch harness TicketInbox.race.test.jsx already established. This is not
// general TicketInbox coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import TicketInbox from './TicketInbox.jsx'

function jsonResponse(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}

/** Flush every pending microtask chain (fetch → json → setState). */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const MAILBOX = { id: 'mb-1', label: 'Front desk', address: 'hello@example.com', is_default: true }
const ROW = {
  id: 'ticket-a', requester_name: 'Alice Archer', requester_email: 'alice@example.com',
  subject: 'Freeze request', status: 'open', unread_count: 0, last_message_at: '2026-08-11T00:00:00Z',
}

const PARTICIPANTS_URL = '/api/email/tickets/ticket-a/participants'

/** One live participant and one the operator already took off. */
function threadPayload() {
  return {
    success: true,
    data: {
      ticket: { ...ROW, excluded_participants: ['gone@example.com'] },
      messages: [{
        id: 'm1', direction: 'inbound', from_email: ROW.requester_email,
        text_body: 'Can I freeze for a month?', created_at: '2026-08-11T10:00:00Z',
      }],
      attachments_unavailable: false,
      reply_recipients: {
        to: ['alice@example.com'], mode: 'reply', over_cap: false, empty: false,
      },
    },
  }
}

/**
 * @param participantsAnswer what PATCH …/participants resolves to
 */
function stubFetch(participantsAnswer) {
  const fetchMock = vi.fn((url) => {
    if (String(url).startsWith('/api/email/tickets?')) {
      return Promise.resolve(jsonResponse({
        success: true, data: { mailboxes: [MAILBOX], tickets: [ROW] },
      }))
    }
    if (url === PARTICIPANTS_URL) return Promise.resolve(jsonResponse(participantsAnswer))
    if (url === '/api/email/tickets/ticket-a') return Promise.resolve(jsonResponse(threadPayload()))
    return new Promise(() => {}) // signature lookup etc — irrelevant here
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The one PATCH this file cares about, decoded. */
function participantsCall(fetchMock) {
  const call = fetchMock.mock.calls.find(([url]) => url === PARTICIPANTS_URL)
  if (!call) return null
  return { url: call[0], method: call[1]?.method, body: JSON.parse(call[1]?.body || 'null') }
}

/** Open the one ticket and wait for its thread. */
async function openTicket() {
  render(<TicketInbox locationId="loc-1" locationName="Test Studio" userId="staff-1" />)
  await screen.findByText('Alice Archer')
  fireEvent.click(screen.getByText('Alice Archer'))
  await screen.findByText('Can I freeze for a month?')
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TicketInbox — the participants write', () => {
  it('removes through PATCH …/participants with { remove: [address] }', async () => {
    const fetchMock = stubFetch({ success: true, data: { excluded_participants: ['gone@example.com', 'alice@example.com'] } })
    await openTicket()

    fireEvent.click(screen.getByRole('button', { name: 'Remove alice@example.com' }))
    await flush()

    expect(participantsCall(fetchMock)).toEqual({
      url: PARTICIPANTS_URL,
      method: 'PATCH',
      body: { remove: ['alice@example.com'] },
    })
  })

  it('restores through the same route with { restore: [address] }', async () => {
    const fetchMock = stubFetch({ success: true, data: { excluded_participants: [] } })
    await openTicket()

    fireEvent.click(screen.getByRole('button', { name: 'Restore gone@example.com' }))
    await flush()

    // Same URL, same method, the other key. A restore posted as a `remove`
    // would read as success and quietly take somebody else off instead.
    expect(participantsCall(fetchMock)).toEqual({
      url: PARTICIPANTS_URL,
      method: 'PATCH',
      body: { restore: ['gone@example.com'] },
    })
  })

  it('leaves the chip in place and says so when the write fails', async () => {
    stubFetch({ success: false, error: 'Not a valid email address: alice@example.com' })
    await openTicket()

    fireEvent.click(screen.getByRole('button', { name: 'Remove alice@example.com' }))
    await flush()

    // NOTHING IS OPTIMISTIC. The write did not land, so that address is still
    // exactly who the next reply reaches — a chip that vanished anyway would be
    // the lie about the audience this whole programme exists to end.
    expect(screen.getByRole('button', { name: 'Remove alice@example.com' })).toBeTruthy()
    expect(screen.getByText('Not a valid email address: alice@example.com')).toBeTruthy()
  })
})
