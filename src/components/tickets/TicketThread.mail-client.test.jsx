// @vitest-environment jsdom
//
// MAILBOX-COEXIST.1 — a reply sent from somebody's own mail client, on screen.
//
// WHY THIS FILE EXISTS
// Phase 8 polls a connected mailbox's Sent folder, so a reply typed in Gmail
// is now filed on the ticket as an outbound row: source 'mail_client', no
// author (nobody signed in to send it), no Postmark id, an RFC Message-ID.
// The whole phase exists to stop TWO PEOPLE ANSWERING ONE MEMBER — and the
// thread pane is where the second of them would start typing.
//
// The lib being honest is not enough, which is the lesson this file is really
// pinning. Before this change src/lib/ticket-display.js already had a careful
// "Not tracked" verdict for a message no provider event can ever confirm, and
// this component printed the literal word "Delivered" for it anyway, because
// it keyed on `tone === 'quiet'` and hard-coded the label. So the one row in
// the thread that can never be confirmed was the row asserting confirmation
// hardest. A test on the lib alone would have passed throughout.
//
// So these are RENDER tests: what an operator actually reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import TicketThread from './TicketThread.jsx'

beforeEach(() => {
  // jsdom has no scrollIntoView; the thread scroll-follows new messages.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  // The assignee picker fetches on mount for elevated viewers. Nothing here
  // wants the network.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const TICKET = {
  id: 'T-9',
  status: 'open',
  subject: 'Membership freeze',
  requester_email: 'ella@member.ie',
  requester_name: 'Ella Byrne',
  mailbox: { id: 'mb-1', label: 'Studio', address: 'hatchstreet@un1t.com' },
}
const noop = () => {}

// The row the Sent lane writes, exactly as the contract specifies it:
// outbound, source 'mail_client', author_profile_id NULL (so no author_name
// comes back from the route), postmark_message_id NULL, rfc_message_id bare.
const FROM_GMAIL = {
  id: 'm-gmail',
  direction: 'outbound',
  is_internal_note: false,
  source: 'mail_client',
  from_email: 'hatchstreet@un1t.com',
  to_email: 'ella@member.ie',
  to_emails: ['ella@member.ie'],
  text_body: 'No problem Ella, your freeze is on from Monday.',
  author_name: null,
  postmark_message_id: null,
  rfc_message_id: 'CAF=9xQ@mail.gmail.com',
  delivery_status: null,
  created_at: '2026-08-26T09:05:00Z',
}

// The same answer, composed here. Identical in every way an operator can see
// except the two facts this change is about.
const FROM_CRM = {
  id: 'm-crm',
  direction: 'outbound',
  is_internal_note: false,
  source: 'operator',
  from_email: 'hatchstreet@un1t.com',
  to_email: 'ella@member.ie',
  to_emails: ['ella@member.ie'],
  text_body: 'No problem Ella, your freeze is on from Monday.',
  author_name: 'Alex Example',
  postmark_message_id: 'a8c1040e-db1c-4e18-ac79-bc5f64c7ce2c',
  rfc_message_id: null,
  delivery_status: null,
  created_at: '2026-08-26T09:05:00Z',
}

function renderThread(messages) {
  return render(
    <TicketThread
      hasSelection
      ticket={TICKET}
      messages={messages}
      currentUserId="me-1"
      onBack={noop}
      onStatusChange={noop}
      onSend={noop}
      onAssign={noop}
    />
  )
}

describe('TicketThread — a reply sent from the mail client', () => {
  it('says on the message that it was sent from the mail client', () => {
    renderThread([FROM_GMAIL])
    expect(screen.getByText('Sent from the mail client')).toBeTruthy()
  })

  // The distinction is the point. A reply composed in the CRM carries an
  // author to name; this one cannot, so the origin is the only answer to "who
  // replied, and from where" that the thread can honestly give.
  it('does NOT say it about a reply composed in the CRM', () => {
    renderThread([FROM_CRM])
    expect(screen.queryByText('Sent from the mail client')).toBeNull()
    expect(screen.getByText(/Replied by Alex Example/)).toBeTruthy()
  })

  it('does not say it about the member’s own mail', () => {
    renderThread([{
      id: 'm-in',
      direction: 'inbound',
      from_email: 'ella@member.ie',
      to_emails: ['hatchstreet@un1t.com'],
      text_body: 'Can I freeze my membership?',
      created_at: '2026-08-26T08:00:00Z',
    }])
    expect(screen.queryByText('Sent from the mail client')).toBeNull()
  })

  // 🔴 THE REGRESSION THIS FILE WAS WRITTEN FOR. `tone: 'quiet'` used to mean
  // "print the word Delivered", so a message the CRM never sent and can never
  // get an event for claimed a confirmed delivery. The tick is now reserved
  // for a real `delivered` status and everything else prints its own label.
  it('never claims DELIVERED for a message the CRM did not send', () => {
    renderThread([FROM_GMAIL])
    expect(screen.queryByText('Delivered')).toBeNull()
    expect(screen.getByText('Not tracked')).toBeTruthy()
  })

  it('still says Delivered when the provider actually confirmed one', () => {
    renderThread([{ ...FROM_CRM, delivery_status: 'delivered' }])
    expect(screen.getByText('Delivered')).toBeTruthy()
  })

  // It is a REPLY, not a note and not a third kind of thing: it reached the
  // member, so it renders in the sent bubble with its recipient on it.
  // messageKind deliberately did not grow a fourth value for this.
  it('renders it as a sent reply, with its recipient', () => {
    renderThread([FROM_GMAIL])
    expect(screen.getByText(/Sent to ella@member\.ie/)).toBeTruthy()
    // The note panel's own heading, not the bare words "Internal note" — the
    // composer below carries a note TOGGLE with that label on every thread.
    expect(screen.queryByText(/Internal note — not sent to the member/i)).toBeNull()
  })
})
