// @vitest-environment jsdom
//
// MAIL-READER.M2 — the desktop thread decodes character references at RENDER,
// like the phone already does.
//
// htmlToPlainText runs at INGEST (the Postmark inbound webhook and
// sent-lane.js both store `TextBody || htmlToPlainText(HtmlBody)`), and until
// MAIL-READER.M1 it decoded a handful of NAMED entities and no numeric ones.
// So `&#38;` is sitting in `email_inbox_messages.text_body` on every row that
// arrived before that fix, estate-wide — the exact thing in Richard's
// screenshot on 2026-09-09.
//
// M1 fixed both ends for the PHONE: the ingest path for new mail, and a
// render-time decode for the rows already stored wrong. It wired the render
// half into the mobile screen ONLY, which left the two surfaces disagreeing
// about the same row — a message reading `100% &#38; rising` at the desk and
// `100% & rising` on a phone. One person works this queue in both places;
// half a fix is worse than a consistent bug, because it reads as the desk
// being broken.
//
// stripInvisibleChars rides along for the same reason it does at ingest: a
// zero-width character decoded out of `&#8204;` is invisible but present, and
// Postgres treats it as a letter (see shared/mail-entities.js).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import ConversationThread from './ConversationThread.jsx'

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const CONVERSATION = {
  id: 'T-1',
  status: 'open',
  subject: 'Meter read',
  requester_email: 'jordan.sample@example.test',
  requester_name: 'Jordan Sample',
  mailbox: { id: 'mb-1', label: 'Accounts', address: 'accounts@hatch.ie' },
}
const noop = () => {}

function renderThread(messages) {
  return render(
    <ConversationThread
      hasSelection
      conversation={CONVERSATION}
      conversationId="T-1"
      messages={messages}
      onSend={noop}
      onArchive={noop}
      onMarkRead={noop}
      onMarkUnread={noop}
    />,
  )
}

function inbound(text_body, extra = {}) {
  return {
    id: 'm1',
    direction: 'inbound',
    from_email: 'jordan.sample@example.test',
    to_emails: ['accounts@hatch.ie'],
    created_at: '2026-08-31T09:00:00Z',
    text_body,
    ...extra,
  }
}

describe('the desktop thread decodes character references in the text body', () => {
  it('decodes a decimal reference — the reported bug', () => {
    renderThread([inbound('Basic-Signing?language=en_US&#38;utm_campaign=GBL')])
    expect(screen.getByText(/utm_campaign/).textContent)
      .toContain('Basic-Signing?language=en_US&utm_campaign=GBL')
    expect(document.body.textContent).not.toContain('&#38;')
  })

  it('decodes a hex reference', () => {
    renderThread([inbound('it&#x27;s the August read')])
    expect(screen.getByText(/August read/).textContent).toContain("it's the August read")
  })

  it('strips a zero-width character back out', () => {
    // Decoded from &#8204; at ingest or here, it is invisible but PRESENT, and
    // Postgres FTS glues it into the surrounding word.
    renderThread([inbound('cli&#8204;ck the link for the reading')])
    expect(screen.getByText(/the link/).textContent).toContain('click the link for the reading')
  })

  it('leaves ordinary text alone', () => {
    renderThread([inbound('100% & rising, no entities here')])
    expect(screen.getByText(/rising/).textContent).toContain('100% & rising, no entities here')
  })

  it('decodes the quoted chain too, not just the body above it', () => {
    // splitQuotedText runs on the SAME string, so decoding before the split
    // covers both halves — the point of doing it at derivation rather than at
    // each of the two render sites.
    //
    // The chain must be EXPANDED first. Asserting on the collapsed thread
    // passes whether or not the fix exists, because the quote is not in the
    // DOM at all until the pill is clicked — a test that proves nothing.
    renderThread([inbound(
      'Sending it now.\n\nOn Fri, Jordan wrote:\n> the reading is 100 &#38; rising\n',
    )])
    fireEvent.click(screen.getByText(/Show quoted text/))
    expect(screen.getByText(/the reading is/).textContent).toContain('100 & rising')
    expect(document.body.textContent).not.toContain('&#38;')
  })

  it('does not touch an internal note differently from a reply', () => {
    // A note is plain text by construction and never takes the HTML path, but
    // it is stored through the same column and can hold the same references.
    renderThread([inbound('chased them 3 &#38; 4 times', { is_internal_note: true })])
    expect(screen.getByText(/chased them/).textContent).toContain('chased them 3 & 4 times')
  })
})
