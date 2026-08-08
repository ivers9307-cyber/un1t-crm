// @vitest-environment jsdom
//
// TICKET-FETCH-RACE.1 — an out-of-order response must not cross tickets.
//
// The bug (2026-08-08 audit, same family as the composer leak): loadThread and
// loadQueue applied whatever response arrived, unconditionally. An operator
// who clicked ticket A and then ticket B — with A's response arriving last —
// was shown A's thread while selectedId was B, and handleSend posts to
// selectedId. The same shape on the queue: a slow response for the previous
// view/mailbox overwrote the list the tabs claimed was on screen.
//
// AttachmentPreview closed this with a requestFor ref (its :106-119); these
// tests pin the same discipline for the inbox's two fetches. Each test hands
// the mock fetch DEFERRED responses and resolves them in the wrong order —
// which is not a stunt: it is what any slow thread read does in production.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import TicketInbox from './TicketInbox.jsx'

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}

/** Flush every pending microtask chain (fetch → json → setState). */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const MAILBOX = { id: 'mb-1', label: 'Front desk', address: 'hello@example.com', is_default: true }

const ROW_A = {
  id: 'ticket-a', requester_name: 'Alice Archer', requester_email: 'alice@example.com',
  subject: 'Freeze request', status: 'open', unread_count: 0, last_message_at: '2026-08-08T00:00:00Z',
}
const ROW_B = {
  id: 'ticket-b', requester_name: 'Bob Byrne', requester_email: 'bob@example.com',
  subject: 'Billing question', status: 'open', unread_count: 0, last_message_at: '2026-08-08T00:01:00Z',
}

function threadPayload(row, fullSubject, messageText) {
  return {
    success: true,
    data: {
      ticket: { ...row, subject: fullSubject },
      messages: [{
        id: `${row.id}-m1`, direction: 'inbound', from_email: row.requester_email,
        text_body: messageText, created_at: '2026-08-01T10:00:00Z',
      }],
      attachments_unavailable: false,
      reply_recipients: null,
    },
  }
}

const QUEUE_URL = '/api/email/tickets?location_id=loc-1'
const QUEUE_URL_UNASSIGNED = '/api/email/tickets?location_id=loc-1&view=unassigned'

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function inbox() {
  return <TicketInbox locationId="loc-1" locationName="Test Studio" userId="staff-1" />
}

describe('TicketInbox — a stale thread response never lands on another ticket', () => {
  it('drops ticket A\'s slow response after the operator opened ticket B', async () => {
    const threadA = deferred()
    const threadB = deferred()

    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).startsWith('/api/email/tickets?')) {
        return Promise.resolve(jsonResponse({
          success: true,
          data: { mailboxes: [MAILBOX], tickets: [ROW_A, ROW_B] },
        }))
      }
      if (url === '/api/email/tickets/ticket-a') return threadA.promise
      if (url === '/api/email/tickets/ticket-b') return threadB.promise
      return new Promise(() => {}) // signature lookup etc — irrelevant here
    }))

    render(inbox())
    await screen.findByText('Alice Archer')

    // Open A, then — before A answers — open B. Ordinary queue triage.
    fireEvent.click(screen.getByText('Alice Archer'))
    fireEvent.click(screen.getByText('Bob Byrne'))

    await act(async () => {
      threadB.resolve(jsonResponse(threadPayload(ROW_B, 'BOB FULL SUBJECT', 'BOB THREAD MESSAGE')))
    })
    await screen.findByText('BOB THREAD MESSAGE')

    // A's response arrives late. It belongs to a ticket that is no longer on
    // screen — applying it would caption Bob's selectedId with Alice's
    // correspondence, and the next Send would post Alice's answer to Bob.
    await act(async () => {
      threadA.resolve(jsonResponse(threadPayload(ROW_A, 'ALICE FULL SUBJECT', 'ALICE THREAD MESSAGE')))
    })
    await flush()

    expect(screen.queryByText('ALICE THREAD MESSAGE')).toBeNull()
    expect(screen.queryByText('ALICE FULL SUBJECT')).toBeNull()
    expect(screen.getByText('BOB THREAD MESSAGE')).toBeTruthy()
  })
})

describe('TicketInbox — a stale queue response never overwrites the current view', () => {
  it('drops the previous view\'s slow response after the operator switched views', async () => {
    const openQueue = deferred()
    const unassignedQueue = deferred()

    vi.stubGlobal('fetch', vi.fn((url) => {
      if (url === QUEUE_URL) return openQueue.promise
      if (url === QUEUE_URL_UNASSIGNED) return unassignedQueue.promise
      return new Promise(() => {})
    }))

    render(inbox())

    // Switch to Unassigned while the Open view's (slow) request is in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Unassigned' }))

    await act(async () => {
      unassignedQueue.resolve(jsonResponse({
        success: true,
        data: { mailboxes: [MAILBOX], tickets: [ROW_B] },
      }))
    })
    await screen.findByText('Bob Byrne')

    // The Open view's response lands late, carrying a ticket the Unassigned
    // view must not show. The tabs say Unassigned; the list has to agree.
    await act(async () => {
      openQueue.resolve(jsonResponse({
        success: true,
        data: { mailboxes: [MAILBOX], tickets: [ROW_A, ROW_B] },
      }))
    })
    await flush()

    expect(screen.queryByText('Alice Archer')).toBeNull()
    expect(screen.getByText('Bob Byrne')).toBeTruthy()
  })
})
