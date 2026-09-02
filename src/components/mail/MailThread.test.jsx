// @vitest-environment jsdom
//
// MAIL-TRIAL.B — the reading pane.
//
// 🔴 WHAT THIS FILE IS REALLY PINNING is that reuse and difference are both
// real at the same time. MailThread is a WRAPPER around TicketThread: if it
// ever becomes a fork, the shared half (the sandboxed HTML frame, attachments,
// the delivery marker, the mail-client marker, the composer) starts drifting
// and the security literals in TicketThread.jsx that src/lib/email-html.test.js
// asserts against would be guarding a file nobody renders on this screen.
//
// So the tests come in two halves:
//   • the shared half must still be there — a message renders, the composer
//     renders, the participant line renders;
//   • the ticket-only half must be GONE — not renamed, not hidden behind a
//     menu: no four-state control, no claim/release/assign, no merge.
// A reskin would pass the first half and fail the second.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import MailThread from './MailThread.jsx'

beforeEach(() => {
  // jsdom has no scrollIntoView; the thread scroll-follows new messages.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CONVERSATION = {
  id: 'conv-1',
  status: 'open',
  subject: 'Membership freeze',
  requester_email: 'ella@member.ie',
  requester_name: 'Ella Byrne',
  mailbox: { id: 'mb-1', label: 'Studio', address: 'hatchstreet@un1t.com' },
  needs_reply: true,
  archived: false,
  unread: false,
}

const INBOUND = {
  id: 'm-1',
  direction: 'inbound',
  is_internal_note: false,
  from_email: 'ella@member.ie',
  to_emails: ['hatchstreet@un1t.com'],
  text_body: 'Can I freeze my membership from Monday?',
  created_at: '2026-08-26T08:00:00Z',
}

function renderThread(props = {}) {
  return render(
    <MailThread
      hasSelection
      conversation={CONVERSATION}
      messages={[INBOUND]}
      currentUserId="me-1"
      onBack={() => {}}
      onSend={() => {}}
      onArchive={() => {}}
      onMarkRead={() => {}}
      {...props}
    />
  )
}

describe('MailThread — the shared half is genuinely reused', () => {
  it('renders the correspondence through TicketThread, not a copy of it', () => {
    renderThread()
    expect(screen.getByText('Can I freeze my membership from Monday?')).toBeTruthy()
    // MAIL-REFINE.1 (02) — the flat message header names the sender and their
    // address on one line (the old bubble said "From <address>"). The header's
    // participant line also names the requester, hence AllBy for the name.
    expect(screen.getAllByText('Ella Byrne').length).toBeGreaterThan(0)
    expect(screen.getAllByText('ella@member.ie').length).toBeGreaterThan(0)
  })

  it('keeps the composer, with its reply/note modes, behind the dock’s slim pill', () => {
    // MAIL-DOCK.1 — this surface now opens the composer COLLAPSED (the
    // mockup's pill). The pill names the requester by first name; clicking
    // it expands the same two-mode composer as ever.
    renderThread()
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Ella…' }))
    expect(screen.getByText('Reply to member')).toBeTruthy()
    expect(screen.getByText('Internal note')).toBeTruthy()
  })

  it('keeps the header facts that are the same on both surfaces', () => {
    // EMAIL-PARTICIPANTS.8's participant line is not a ticketing feature — an
    // operator answering the wrong person is a mail problem.
    renderThread({ conversation: { ...CONVERSATION }, replyRecipients: { to: ['ella@member.ie'], mode: 'reply' } })
    // Mail-client form, name attached to the one address it belongs to —
    // TicketThread's own rule, inherited rather than restated.
    expect(screen.getByText('On this thread: Ella Byrne <ella@member.ie>')).toBeTruthy()
    expect(screen.getByText(/To Studio/)).toBeTruthy()
  })
})

// 🔴 The half that makes this a different surface rather than a reskin.
describe('MailThread — the ticket lifecycle is gone, not renamed', () => {
  it('has no four-state status control', () => {
    renderThread()
    expect(screen.queryByRole('group', { name: 'Ticket status' })).toBeNull()
    for (const label of ['Open', 'Pending', 'Solved', 'Closed']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    expect(screen.queryByText(/Nothing closes itself/)).toBeNull()
  })

  it('has no assignment: no claim, no release, no reassign picker', () => {
    // Measured against prod, assignment was used ZERO times in 17 days. It is
    // not hidden here — there is no handler to call.
    renderThread()
    expect(screen.queryByRole('button', { name: 'Claim' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull()
    expect(screen.queryByLabelText('Assign to')).toBeNull()
    expect(screen.queryByText('Owner')).toBeNull()
  })

  it('has no merge ceremony', () => {
    renderThread()
    expect(screen.queryByText('Duplicate')).toBeNull()
    expect(screen.queryByText(/Fold this one into it/)).toBeNull()
  })
})

describe('MailThread — archive is the verb, in this surface’s own words', () => {
  it('offers Archive on a live conversation', () => {
    const onArchive = vi.fn()
    renderThread({ onArchive })
    screen.getByRole('button', { name: /^Archive$/ }).click()
    expect(onArchive).toHaveBeenCalledWith(true)
  })

  it('offers the way back on an archived one, and chips it as Archived', () => {
    const onArchive = vi.fn()
    renderThread({
      conversation: { ...CONVERSATION, status: 'closed', archived: true, needs_reply: false },
      onArchive,
    })
    expect(screen.getByText('Archived')).toBeTruthy()
    // Never the word "Closed", which is what the same row says on disk.
    expect(screen.queryByText('Closed')).toBeNull()
    screen.getByRole('button', { name: /Move back to inbox/ }).click()
    expect(onArchive).toHaveBeenCalledWith(false)
  })

  it('tells the operator that replying brings an archived conversation back — in inbox words', () => {
    renderThread({ conversation: { ...CONVERSATION, status: 'closed', archived: true } })
    // MAIL-DOCK.1 — the sentence lives on the EXPANDED composer; the pill is
    // what an archived conversation shows first, same as a live one.
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Ella…' }))
    expect(screen.getByText(/replying brings it back to the inbox/)).toBeTruthy()
    // The composer's own default sentence is the ticket lifecycle's. On this
    // screen it would contradict the chip six lines above it.
    expect(screen.queryByText(/back to pending/)).toBeNull()
  })
})

describe('MailThread — read state', () => {
  it('offers Mark read while anything on the conversation is unread', () => {
    const onMarkRead = vi.fn()
    renderThread({ conversation: { ...CONVERSATION, unread: true }, onMarkRead })
    screen.getByRole('button', { name: 'Mark read' }).click()
    expect(onMarkRead).toHaveBeenCalledTimes(1)
  })

  // The control flips rather than appearing and disappearing — the operator's
  // defer verb has to be in the same place every time they reach for it. It is
  // offerable at all only because the route pairs it with markUnseen() over
  // IMAP; see the seen route's header for why a column-only version would undo
  // itself within about a quarter of an hour.
  it('offers Mark unread once the conversation is read, and calls back', () => {
    const onMarkUnread = vi.fn()
    renderThread({ conversation: { ...CONVERSATION, unread: false }, onMarkUnread })
    expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull()
    screen.getByRole('button', { name: 'Mark unread' }).click()
    expect(onMarkUnread).toHaveBeenCalledTimes(1)
  })

})

describe('MailThread — needs-reply is the one signal kept', () => {
  it('chips a conversation waiting on the studio', () => {
    renderThread()
    expect(screen.getByText('Needs reply')).toBeTruthy()
  })

  it('chips nothing on an ordinary answered conversation', () => {
    renderThread({ conversation: { ...CONVERSATION, needs_reply: false, status: 'pending' } })
    expect(screen.queryByText('Needs reply')).toBeNull()
    expect(screen.queryByText('Pending')).toBeNull()
  })
})

describe('MailThread — with nothing selected', () => {
  it('says conversation, not ticket, and names the shortcuts', () => {
    renderThread({ hasSelection: false })
    expect(screen.getByText('Select a conversation')).toBeTruthy()
    expect(screen.queryByText('Select a ticket')).toBeNull()
    // An undiscoverable shortcut is the same as no shortcut.
    expect(screen.getByText(/j and k move between conversations/)).toBeTruthy()
  })
})
