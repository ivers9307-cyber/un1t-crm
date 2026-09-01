// @vitest-environment jsdom
//
// MAIL-REFINE.1 (02) — the flat thread: email, not chat.
//
// Bubbles capped at ~75% width and padded heavily, so three short messages
// filled the pane. Messages are now full-width flat blocks separated by
// hairlines, and ALL BUT THE NEWEST arrive collapsed to a single line —
// avatar, sender, snippet, time — expanding (and collapsing again) on click.
//
// What must never collapse away, pinned hard:
//   • an internal note's amber, staff-only identity — in BOTH states;
//   • a delivery FAILURE panel, even when its message is collapsed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import TicketThread from './TicketThread.jsx'

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const TICKET = {
  id: 'T-1',
  status: 'open',
  subject: 'Flogas bill for Hatch Street',
  requester_email: 'caitlin.thornton@flogas.ie',
  requester_name: 'Caitlin Thornton',
  mailbox: { id: 'mb-1', label: 'Accounts', address: 'accounts@hatch.ie' },
}
const noop = () => {}

// Bodies deliberately LONGER than the snippet cap, so the full text is only
// on screen when the message is genuinely expanded — a snippet echoing a
// short body in full would make these assertions prove nothing.
const pad = ' Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis.'
const OLDEST = {
  id: 'm1',
  direction: 'inbound',
  from_email: 'caitlin.thornton@flogas.ie',
  to_emails: ['accounts@hatch.ie'],
  text_body: 'Our records show the August meter read is outstanding.' + pad,
  created_at: '2026-08-28T09:00:00Z',
}
const MIDDLE = {
  id: 'm2',
  direction: 'outbound',
  from_email: 'accounts@hatch.ie',
  to_email: 'caitlin.thornton@flogas.ie',
  to_emails: ['caitlin.thornton@flogas.ie'],
  author_name: 'Dean Kelly',
  text_body: 'Thanks for the reminder, the reading goes over tomorrow morning.' + pad,
  created_at: '2026-08-29T09:00:00Z',
}
const NEWEST = {
  id: 'm3',
  direction: 'inbound',
  from_email: 'caitlin.thornton@flogas.ie',
  to_emails: ['accounts@hatch.ie'],
  text_body: 'Just following up on the meter read, we need it before Friday.' + pad,
  created_at: '2026-08-31T09:00:00Z',
}

function renderThread(props = {}) {
  return render(
    <TicketThread
      hasSelection
      ticket={TICKET}
      messages={[OLDEST, MIDDLE, NEWEST]}
      currentUserId="me-1"
      onBack={noop}
      onSend={noop}
      {...props}
    />
  )
}

describe('TicketThread — only the newest message opens by default', () => {
  it('renders the newest in full and the older ones as single collapsed lines', () => {
    renderThread()
    // Newest: full body on screen.
    expect(screen.getByText(NEWEST.text_body)).toBeTruthy()
    // Older two: full bodies NOT on screen (only their truncated snippets).
    expect(screen.queryByText(OLDEST.text_body)).toBeNull()
    expect(screen.queryByText(MIDDLE.text_body)).toBeNull()
    // The collapsed lines are labelled expandable buttons.
    expect(screen.getByRole('button', { name: /Expand the message from Caitlin Thornton/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Expand the message from You/ })).toBeTruthy()
  })

  it('expands a collapsed message on click, and collapses it again', () => {
    renderThread()
    fireEvent.click(screen.getByRole('button', { name: /Expand the message from Caitlin Thornton/ }))
    expect(screen.getByText(OLDEST.text_body)).toBeTruthy()
    // The expanded header is the way back down. Two of Caitlin's messages are
    // open now (the labels differ only by their stamp) — the oldest is first
    // in the DOM.
    fireEvent.click(screen.getAllByRole('button', { name: /Collapse the message from caitlin\.thornton@flogas\.ie/ })[0])
    expect(screen.queryByText(OLDEST.text_body)).toBeNull()
  })

  it('renders an outbound reply flat — its recipient facts, not a bubble', () => {
    renderThread()
    fireEvent.click(screen.getByRole('button', { name: /Expand the message from You/ }))
    expect(screen.getByText(MIDDLE.text_body)).toBeTruthy()
    expect(screen.getByText(/Sent to caitlin\.thornton@flogas\.ie/)).toBeTruthy()
    expect(screen.getByText(/Replied by Dean Kelly/)).toBeTruthy()
  })

  it('keeps a single-message thread fully open — there is nothing older to fold', () => {
    renderThread({ messages: [NEWEST] })
    expect(screen.getByText(NEWEST.text_body)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Expand the message/ })).toBeNull()
  })
})

describe('TicketThread — the note never loses its identity', () => {
  const NOTE = {
    id: 'n1',
    direction: 'outbound',
    is_internal_note: true,
    author_name: 'Dean Kelly',
    text_body: 'She rang about this too, waiting on the meter photo from the coach.' + pad,
    created_at: '2026-08-27T09:00:00Z',
  }

  it('collapsed: amber, locked and marked STAFF-ONLY — never skimmable as correspondence', () => {
    renderThread({ messages: [NOTE, NEWEST] })
    const line = screen.getByRole('button', { name: /Expand the message from Dean Kelly/ })
    expect(line.className).toContain('bg-amber-500/10')
    expect(line.textContent).toContain('STAFF-ONLY')
    expect(screen.queryByText(NOTE.text_body)).toBeNull()
  })

  it('expanded: the full staff-only heading, and it can fold back down', () => {
    renderThread({ messages: [NEWEST, NOTE] }) // note newest → open by default
    expect(screen.getByText(/Internal note — not sent to the member/)).toBeTruthy()
    expect(screen.getByText(NOTE.text_body)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Collapse the note by Dean Kelly/ }))
    expect(screen.queryByText(NOTE.text_body)).toBeNull()
    expect(screen.getByText(/STAFF-ONLY/)).toBeTruthy()
  })
})

describe('TicketThread — a delivery failure refuses to collapse away', () => {
  it('shows the failure panel even while its message is folded', () => {
    const BOUNCED = {
      ...MIDDLE,
      id: 'm-bounced',
      postmark_message_id: 'pm-1',
      delivery_status: 'bounced',
      delivery_detail: 'The mailbox is full.',
    }
    renderThread({ messages: [BOUNCED, NEWEST] })
    // The message itself is collapsed…
    expect(screen.queryByText(BOUNCED.text_body)).toBeNull()
    // …but the loud panel is not: the provider's own words stay on screen.
    expect(screen.getByText('The mailbox is full.')).toBeTruthy()
  })
})

describe('TicketThread — the banner slot', () => {
  it('renders the caller’s banner between the header and the thread; nothing when unset', () => {
    renderThread({ banner: <div data-testid="the-banner">related things</div> })
    expect(screen.getByTestId('the-banner')).toBeTruthy()
    cleanup()
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    renderThread()
    expect(screen.queryByTestId('the-banner')).toBeNull()
  })
})

// ── MAIL-REFINE.2 — the "Merged in" divider + the tombstone's pointer ───
describe('merged-in provenance', () => {
  const ABSORBED_A = {
    ...OLDEST,
    id: 'ma1',
    merged_from_ticket_id: 'T-src',
    text_body: 'The reading is 048122.' + pad,
    created_at: '2026-08-28T10:00:00Z',
  }
  const ABSORBED_B = { ...ABSORBED_A, id: 'ma2', created_at: '2026-08-28T11:00:00Z' }

  it('renders ONE divider per absorbed conversation, naming its subject and count', () => {
    renderThread({
      messages: [OLDEST, ABSORBED_A, ABSORBED_B, NEWEST],
      mergedSources: [{ id: 'T-src', subject: 'RE: Meter reading — urgent', merged_at: '2026-08-31T20:00:00Z' }],
    })
    const dividers = screen.getAllByTestId('merged-in-divider')
    expect(dividers).toHaveLength(1)
    expect(dividers[0].textContent).toContain('RE: Meter reading — urgent')
    expect(dividers[0].textContent).toContain('2 messages')
  })

  it('degrades to generic wording when the source subject is unresolvable — never hides the fact', () => {
    renderThread({ messages: [ABSORBED_A, NEWEST], mergedSources: [] })
    expect(screen.getByTestId('merged-in-divider').textContent)
      .toContain('Merged in from another conversation')
  })

  it('renders no divider on an unmerged thread', () => {
    renderThread()
    expect(screen.queryByTestId('merged-in-divider')).toBeNull()
  })

  it('the tombstone pointer is a working verb when the surface can navigate', () => {
    const onOpenMergedInto = vi.fn()
    renderThread({
      ticket: { ...TICKET, merged_into_id: 'T-target' },
      onOpenMergedInto,
    })
    fireEvent.click(screen.getByRole('button', { name: /Open the conversation it lives in now/ }))
    expect(onOpenMergedInto).toHaveBeenCalledWith('T-target')
  })
})
