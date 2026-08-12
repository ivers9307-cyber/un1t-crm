// @vitest-environment jsdom
//
// EMAIL-MERGE.6 — the client half of the merge contract.
//
// TicketInbox owns both writes, so this file is where the wire format and the
// 409 live. Two things can only be seen from here:
//
//   • the POST body. `{ into: <id> }` is the whole contract, and getting it
//     wrong fails in the shape this programme keeps finding — the dialog
//     closes, nothing moves, and the duplicate is still there.
//   • the LOST RACE. A 409 means somebody merged this ticket first, so the
//     view on screen is wrong about where the conversation now lives. Leaving
//     it there is how an operator replies into a ticket whose messages have
//     already gone somewhere else — the exact failure merge exists to end.
//
// Deliberately narrow, through the real TicketInbox, on the mock-fetch harness
// TicketInbox.race.test.jsx established. Not general TicketInbox coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react'
import TicketInbox from './TicketInbox.jsx'

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) }
}

/** Flush every pending microtask chain (fetch → json → setState). */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const MAILBOX = { id: 'mb-1', label: 'Front desk', address: 'hello@example.com', is_default: true }

/** The ticket being folded away — the one on screen. */
const ROW = {
  id: 'ticket-a', requester_name: 'Alice Archer', requester_email: 'alice@example.com',
  subject: 'Rates query', status: 'open', unread_count: 0, mailbox_id: MAILBOX.id,
  location_id: 'loc-1', last_message_at: '2026-08-11T00:00:00Z',
}
/** The survivor. */
const OTHER = {
  id: 'ticket-b', requester_name: 'Eleanor Clerk', requester_email: 'eleanor@council.ie',
  subject: 'Commercial rates 2026', status: 'open', unread_count: 0, mailbox_id: MAILBOX.id,
  location_id: 'loc-1', last_message_at: '2026-08-11T01:00:00Z',
}

const MERGE_URL = '/api/email/tickets/ticket-a/merge'

function threadPayload(ticket) {
  return {
    success: true,
    data: {
      ticket: { ...ticket, mailbox: MAILBOX },
      messages: [{
        id: 'm1', direction: 'inbound', from_email: ticket.requester_email,
        text_body: 'What are the rates for 2026?', created_at: '2026-08-11T10:00:00Z',
      }],
      attachments_unavailable: false,
      reply_recipients: { to: [ticket.requester_email], mode: 'reply', over_cap: false, empty: false },
    },
  }
}

/**
 * @param onMerge  (call) => a Response for POST/DELETE …/merge
 */
function stubFetch(onMerge) {
  // Mutable so a test can make the world change under the operator, which is
  // the only way to tell a real refresh from a dialog that merely closed.
  const state = { aMergedInto: null }
  const fetchMock = vi.fn((url, init) => {
    const u = String(url)
    if (u.startsWith('/api/email/tickets?')) {
      const tickets = [state.aMergedInto ? null : ROW, OTHER].filter(Boolean)
      return Promise.resolve(jsonResponse({ success: true, data: { mailboxes: [MAILBOX], tickets } }))
    }
    if (u === MERGE_URL) return Promise.resolve(onMerge({ init, state }))
    if (u === '/api/email/tickets/ticket-a') {
      return Promise.resolve(jsonResponse(threadPayload({ ...ROW, merged_into_id: state.aMergedInto })))
    }
    if (u === '/api/email/tickets/ticket-b') return Promise.resolve(jsonResponse(threadPayload(OTHER)))
    return new Promise(() => {}) // signature lookup etc — irrelevant here
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The one merge request, decoded. */
function mergeCall(fetchMock) {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === MERGE_URL)
  if (!call) return null
  return { method: call[1]?.method, body: call[1]?.body ? JSON.parse(call[1].body) : null }
}

/** Open ticket-a, walk the picker to the confirm step, and press Merge. */
async function mergeIntoOther() {
  render(<TicketInbox locationId="loc-1" locationName="Test Studio" userId="staff-1" />)
  await screen.findByText('Alice Archer')
  fireEvent.click(screen.getByText('Alice Archer'))
  await screen.findByText('What are the rates for 2026?')

  fireEvent.click(screen.getByRole('button', { name: /merge into/i }))
  // SCOPED TO THE DIALOG on purpose: the survivor is also a row in the queue
  // behind it, so an unscoped query for its subject clicks the QUEUE and
  // silently switches ticket instead of picking a merge target.
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(await within(dialog).findByRole('button', { name: /Commercial rates 2026/i }))
  fireEvent.click(within(dialog).getByRole('button', { name: /^merge$/i }))
  await flush()
}

beforeEach(() => { window.HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('TicketInbox — the merge write', () => {
  it('posts { into: <target id> } to the source ticket', async () => {
    const fetchMock = stubFetch(({ state }) => {
      state.aMergedInto = OTHER.id
      return jsonResponse({ success: true, data: { ticket_id: ROW.id, merged_into_id: OTHER.id } })
    })
    await mergeIntoOther()

    // The path names the ticket that GOES AWAY and the body names the survivor.
    // Swapped, this merges the wrong one away — and the undo would restore the
    // conversation to a ticket nobody chose.
    expect(mergeCall(fetchMock)).toEqual({ method: 'POST', body: { into: OTHER.id } })
  })

  it('stays on the merged ticket so the undo is still reachable', async () => {
    stubFetch(({ state }) => {
      state.aMergedInto = OTHER.id
      return jsonResponse({ success: true, data: { ticket_id: ROW.id, merged_into_id: OTHER.id } })
    })
    await mergeIntoOther()
    await flush()

    // A tombstone is hidden from every list the moment it is stamped, so
    // navigating to the survivor on success would put Undo permanently out of
    // reach. The operator stays put and the banner appears instead.
    //
    // Scoped to the banner: the header's status strip has an "Open" pill, and
    // an unscoped match would pass on the wrong button entirely.
    const banner = await screen.findByTestId('merge-banner')
    expect(within(banner).getByRole('button', { name: /undo/i })).toBeTruthy()
    expect(within(banner).getByRole('button', { name: /open/i })).toBeTruthy()
  })

  it('takes the composer away once the ticket is a tombstone', async () => {
    stubFetch(({ state }) => {
      state.aMergedInto = OTHER.id
      return jsonResponse({ success: true, data: { ticket_id: ROW.id, merged_into_id: OTHER.id } })
    })
    await mergeIntoOther()
    await flush()

    // THE HOLE THIS CLOSES. The reply route gates on loadTicketForUser, which
    // does not care whether a ticket has been merged — so a reply sent from
    // here reaches the member and is then filed on a ticket hidden from every
    // queue and count. That is the duplicate-reply failure merge exists to
    // end, and staying on the tombstone (so Undo stays reachable) is what puts
    // the operator in front of that box.
    expect(screen.queryByLabelText('Reply to the member')).toBeNull()
    expect(screen.getByText(/read-only/i)).toBeTruthy()
  })

  it('refreshes rather than argue when somebody merged it first (409)', async () => {
    stubFetch(({ state }) => {
      // The other operator's merge already landed — which is why this 409ed.
      state.aMergedInto = OTHER.id
      return jsonResponse({
        success: false,
        error: 'Somebody else merged this ticket while you were looking at it. Reload to see where its messages went.',
      }, 409)
    })
    await mergeIntoOther()
    await flush()

    // The dialog gets out of the way: it is arguing about a ticket that is no
    // longer in the state it was opened on.
    expect(screen.queryByRole('dialog')).toBeNull()
    // It says what happened, in the route's own words.
    expect(screen.getByText(/somebody else merged this ticket/i)).toBeTruthy()
    // AND THE VIEW IS ACTUALLY REFRESHED, not merely closed. The banner is the
    // proof: it can only be here if the thread was re-read after the refusal.
    // Left stale, this pane would still be offering a Reply into a ticket whose
    // messages have already moved.
    expect(await screen.findByRole('button', { name: /undo/i })).toBeTruthy()
  })

  it('keeps the dialog open and explains when the merge is refused', async () => {
    stubFetch(() => jsonResponse({ success: false, error: 'Not found' }, 404))
    await mergeIntoOther()

    // Nothing changed, so the dialog stays useful — and the operator gets a
    // sentence naming the reasons they can act on rather than the route's bare
    // "Not found", which is deliberately the same answer for four refusals.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/cannot be merged/i)).toBeTruthy()
  })
})

describe('TicketInbox — the undo', () => {
  it('DELETEs the same route and brings the ticket back', async () => {
    const fetchMock = stubFetch(({ init, state }) => {
      if (init?.method === 'DELETE') {
        state.aMergedInto = null
        return jsonResponse({ success: true, data: { ticket_id: ROW.id, unmerged_from: OTHER.id } })
      }
      state.aMergedInto = OTHER.id
      return jsonResponse({ success: true, data: { ticket_id: ROW.id, merged_into_id: OTHER.id } })
    })
    await mergeIntoOther()
    await flush()

    fireEvent.click(await screen.findByRole('button', { name: /undo/i }))
    await flush()
    await flush()

    // Same route, the other verb — the route's own symmetry, so a merge and its
    // reversal cannot drift onto different endpoints.
    const del = fetchMock.mock.calls.find(([url, i]) => String(url) === MERGE_URL && i?.method === 'DELETE')
    expect(del).toBeTruthy()

    // And the banner is gone: the ticket is a live ticket again, so the merge
    // action must be back rather than a stale "Merged into…" strip.
    expect(await screen.findByRole('button', { name: /merge into/i })).toBeTruthy()
  })
})
