// @vitest-environment jsdom
//
// EMAIL-PARTICIPANTS.8 — the thread has to read like a mail thread.
//
// THE INCIDENT THESE TESTS EXIST FOR (2026-08-12)
// A ticket's requester_email was ratesoffice@dublincity.ie. The rates office
// forwarded the mail internally to a named officer, eleanor.brennan@…, who
// replied. Every message from that point on was with Eleanor — and the header
// still said ratesoffice@, with nothing anywhere saying a new person had
// joined. The operator, reading the wrong name, opened a second ticket and
// sent the same reply twice.
//
// Tasks 2-7 fixed WHO a reply reaches. None of that is visible, so none of it
// would have stopped this: the operator's mistake was made before they typed.
// These pin the VISIBILITY half — that the change of counterparty is on
// screen, in each of the three places an operator looks: the header, the
// message it happened on, and that message's own envelope.
//
// jsdom + testing-library (the Modal.focus.test.jsx / TicketThread.assign
// idiom) because these are questions about what renders — the join markers are
// computed from the messages rather than handed in as a prop, and the envelope
// is a behaviour (a click) that static markup cannot see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
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
  id: 'T-1',
  status: 'open',
  subject: 'Commercial rates 2026',
  requester_email: 'rates@council.ie',
  requester_name: 'Rates Office',
  mailbox: { id: 'mb-1', label: 'Studio', address: 'studio@x.com' },
}
const noop = () => {}

function renderThread(props = {}) {
  return render(
    <TicketThread
      hasSelection
      ticket={TICKET}
      messages={[]}
      currentUserId="me-1"
      onBack={noop}
      onStatusChange={noop}
      onSend={noop}
      onAssign={noop}
      {...props}
    />
  )
}

describe('TicketThread — where a participant joined', () => {
  it('marks the message a new participant joined on', () => {
    renderThread({
      messages: [
        {
          id: 'm1',
          direction: 'outbound',
          from_email: 'studio@x.com',
          to_email: 'rates@council.ie',
          to_emails: ['rates@council.ie'],
          text_body: 'Our rates account reference is 41221.',
          created_at: '2026-08-10T09:00:00Z',
        },
        {
          id: 'm2',
          direction: 'inbound',
          from_email: 'eleanor@council.ie',
          to_emails: ['studio@x.com'],
          text_body: 'Taking this over from the rates office.',
          created_at: '2026-08-11T09:00:00Z',
        },
      ],
    })

    // The moment the counterparty changed, said in words, against the message
    // it changed on. This is the sentence whose absence cost a duplicate reply.
    expect(screen.getByText(/eleanor@council\.ie joined this thread/i)).toBeTruthy()
  })
})

describe('TicketThread — who the ticket is actually with', () => {
  it('names the live correspondent in the header, not only the requester', () => {
    renderThread({
      // The audience as the server derived it from the whole thread: Eleanor
      // first, because she is who the next reply goes to.
      replyRecipients: {
        to: ['eleanor@council.ie', 'rates@council.ie'],
        mode: 'reply_all',
        over_cap: false,
        empty: false,
      },
    })

    // Eleanor is on screen at the top, and the list is the server's — same
    // people, same order, as the reply will actually reach. The header used to
    // show requester_email and nothing else, which is precisely the wrong name.
    //
    // The requester's NAME rides on their own address rather than sitting
    // above the list: a human name is what an operator scans for, but a name
    // on its own line is the wrong name in the most prominent place the moment
    // the thread has moved on.
    //
    // Matched as the whole line rather than "somewhere on the page": the
    // composer below renders these addresses too, and it already did on the
    // day of the incident. Being in the composer is not being in the header.
    expect(
      screen.getByText('On this thread: eleanor@council.ie, Rates Office <rates@council.ie>')
    ).toBeTruthy()

    // And the requester is not erased — demoted. "Opened by" is how an
    // operator reconciles the ticket in front of them with the address it
    // arrived from, and it appears BECAUSE the two have diverged.
    expect(screen.getByText('Opened by Rates Office <rates@council.ie>')).toBeTruthy()
  })
})

describe('TicketThread — a message\'s own envelope', () => {
  it('hides the envelope until asked, then shows the real From / To / Cc', () => {
    renderThread({
      messages: [{
        id: 'm1',
        direction: 'inbound',
        from_email: 'eleanor@council.ie',
        to_emails: ['studio@x.com'],
        cc_emails: ['clerk@council.ie'],
        bcc_emails: ['secret@x.com'],
        text_body: 'Taking this over from the rates office.',
        created_at: '2026-08-11T09:00:00Z',
      }],
    })

    // Collapsed at rest. An envelope permanently open on every bubble is three
    // lines of addresses above two lines of message, and an operator stops
    // reading both.
    const details = screen.getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('clerk@council.ie')).toBeNull()

    // BCC IS THE EXCEPTION AND IS ALREADY VISIBLE, before any click. It is the
    // highest-consequence line on a message here — a whole invariant exists
    // about a Bcc address never re-entering a recipient list — so it must not
    // be the thing an operator has to go looking for.
    expect(screen.getByText('secret@x.com')).toBeTruthy()
    expect(screen.getByText(/Only staff on this ticket can see this/)).toBeTruthy()

    fireEvent.click(details)

    // One click and it is the header a mail client would show. The From line
    // is the half that was missing: without it a reply from a different person
    // at the same organisation looked exactly like one from the requester.
    expect(screen.getByText('eleanor@council.ie')).toBeTruthy()
    expect(screen.getByText('studio@x.com')).toBeTruthy()
    expect(screen.getByText('clerk@council.ie')).toBeTruthy()

    // Bcc is shown here and NOWHERE else — never in the header's participant
    // list, and never as a join marker, where it would leak to everyone
    // reading the ticket.
    expect(screen.queryByText(/secret@x\.com joined this thread/i)).toBeNull()

    // Collapsing takes To and Cc away again, and leaves the Bcc where it was.
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(screen.queryByText('clerk@council.ie')).toBeNull()
    expect(screen.getByText('secret@x.com')).toBeTruthy()
  })
})
