// @vitest-environment jsdom
//
// TICKET-COMPOSER-LEAK.1 — switching tickets must not carry the composer.
//
// The bug (2026-08-08 audit, confirmed HIGH): TicketReplyBox holds its mode,
// draft text, added Cc/Bcc and attached files in local state, and TicketThread
// rendered it without a key — so React kept the same component instance across
// a ticket switch. Member A's half-written reply, internal-note mode and
// committed Bcc chips all survived onto member B's ticket, where Send would
// deliver them to B's requester. TicketInbox already scrupulously clears the
// server-derived replyRecipients on switch; this pins the same discipline for
// the operator-typed half.
//
// jsdom + testing-library (the Modal.focus.test.jsx idiom) because the defect
// IS a state-across-rerender behaviour — static markup cannot see it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import TicketThread from './TicketThread.jsx'

beforeEach(() => {
  // TicketReplyBox fetches the viewer's signature on mount. Never resolving is
  // the quiet stub: the composer treats a missing signature as cosmetic.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  // jsdom implements no layout — the thread's scroll-to-newest effect needs
  // the method to exist, not to work.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const noop = () => {}

function threadProps(ticket) {
  return {
    hasSelection: true,
    ticket,
    messages: [],
    replyRecipients: null,
    loading: false,
    error: null,
    currentUserId: 'staff-1',
    onBack: noop,
    onStatusChange: noop,
    statusSaving: false,
    onSend: noop,
    sending: false,
  }
}

const TICKET_A = { id: 'ticket-a', subject: 'Membership freeze', requester_email: 'alice@example.com', status: 'open' }
const TICKET_B = { id: 'ticket-b', subject: 'Billing question', requester_email: 'bob@example.com', status: 'open' }

describe('TicketThread — the composer belongs to one ticket', () => {
  it('drops a half-written draft when the operator switches tickets', () => {
    const { rerender } = render(<TicketThread {...threadProps(TICKET_A)} />)

    const draft = screen.getByLabelText('Reply to the member')
    fireEvent.change(draft, { target: { value: 'Hi Alice — about your freeze…' } })
    expect(draft.value).toBe('Hi Alice — about your freeze…')

    rerender(<TicketThread {...threadProps(TICKET_B)} />)

    // A draft written for Alice must never sit in Bob's composer: Send there
    // delivers it to Bob's requester.
    expect(screen.getByLabelText('Reply to the member').value).toBe('')
  })

  it('resets internal-note mode to reply when the operator switches tickets', () => {
    const { rerender } = render(<TicketThread {...threadProps(TICKET_A)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }))
    // Note mode is on: the textarea is now labelled as the staff-only field.
    expect(screen.getByLabelText('Internal note (staff only)')).toBeTruthy()

    rerender(<TicketThread {...threadProps(TICKET_B)} />)

    // Mode must not follow the operator to the next ticket — a reply typed
    // into a composer silently left in note mode is never sent, and the
    // member waits on an answer staff believe went out.
    expect(screen.getByLabelText('Reply to the member')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reply to member' }).getAttribute('aria-pressed')).toBe('true')
  })
})
