// @vitest-environment jsdom
//
// EMAIL-MERGE.6 — the merge picker, its confirm step, and the undo banner.
//
// THE INCIDENT THIS FEATURE ANSWERS: two tickets that were one conversation
// with Dublin City Council. An operator replied on both and the council got the
// same answer twice. Merge folds them; mig 536 makes it reversible.
//
// Merging is the most consequential thing on this surface that is not a send:
// it moves ANOTHER ticket's correspondence, closes a ticket, and — across
// mailboxes — changes who is able to read it. So the tests here are about the
// operator understanding what they are about to do, not about the mechanics,
// which the route's own tests own.
//
// jsdom + testing-library (the TicketReplyBox.participants.test.jsx idiom)
// because every one of these is a BEHAVIOUR — a two-step flow, a dismissal
// that must not write, a warning that must appear on one input and not on
// another. Static markup cannot see any of it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import TicketMerge from './TicketMerge.jsx'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const MB_STUDIO = { id: 'mb-studio', label: 'Studio', address: 'studio@un1tdublin.com' }
const MB_ACCOUNTS = { id: 'mb-accounts', label: 'Accounts', address: 'accounts@un1tdublin.com' }

/** The ticket being folded AWAY — the one the operator is looking at. */
const SOURCE = {
  id: 'ticket-source',
  location_id: LOC,
  mailbox_id: MB_STUDIO.id,
  mailbox: MB_STUDIO,
  subject: 'Rates query',
  requester_email: 'rates@council.ie',
  merged_into_id: null,
}

/** The survivor, on the SAME mailbox — the no-warning case. */
const TARGET_SAME_MAILBOX = {
  id: 'ticket-target',
  location_id: LOC,
  mailbox_id: MB_STUDIO.id,
  subject: 'Commercial rates 2026',
  requester_email: 'eleanor@council.ie',
  status: 'open',
  last_message_at: '2026-08-12T09:00:00Z',
}

/** …and one on a DIFFERENT mailbox — the case that widens who can read. */
const TARGET_OTHER_MAILBOX = {
  ...TARGET_SAME_MAILBOX,
  id: 'ticket-target-accounts',
  mailbox_id: MB_ACCOUNTS.id,
  subject: 'Direct debit bounced',
}

/**
 * Route fetches by URL. The picker reads the queue; the merged banner reads the
 * survivor's detail. Anything unmatched answers an empty success, which is what
 * a component asking for something these tests do not care about should see.
 */
function stubFetch({ tickets = [], mailboxes = [MB_STUDIO, MB_ACCOUNTS], survivor = null } = {}) {
  const fetchMock = vi.fn(async (url) => {
    const u = String(url)
    if (u.startsWith('/api/email/tickets?')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { tickets, mailboxes } }) }
    }
    if (u.startsWith('/api/email/tickets/')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { ticket: survivor } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => { stubFetch() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderMerge(props = {}) {
  return render(
    <TicketMerge
      ticket={SOURCE}
      messageCount={3}
      onMerge={vi.fn(async () => ({ ok: true }))}
      onUnmerge={vi.fn(async () => ({ ok: true }))}
      onOpenTicket={vi.fn()}
      {...props}
    />
  )
}

/** Open the picker and walk to the confirm step for `candidate`. */
async function openConfirm(candidate, props = {}) {
  const utils = renderMerge(props)
  fireEvent.click(screen.getByRole('button', { name: /merge into/i }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(candidate.subject, 'i') }))
  return utils
}

describe('TicketMerge — the confirm step', () => {
  it('names both subjects and how many messages move', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    await openConfirm(TARGET_SAME_MAILBOX)

    // BOTH tickets are named. This action moves another ticket's
    // correspondence, so a confirm that named only one of them would be asking
    // the operator to approve half a sentence.
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Rates query')
    expect(dialog.textContent).toContain('Commercial rates 2026')

    // …and how much moves. "3 messages" is the number that makes the
    // consequence concrete — the difference between folding away a stray
    // one-liner and moving a whole correspondence.
    expect(dialog.textContent).toMatch(/3 messages/i)

    // Which one DISAPPEARS and which one SURVIVES has to be unambiguous, not
    // inferable from word order. The two are labelled.
    expect(screen.getByTestId('merge-disappears').textContent).toContain('Rates query')
    expect(screen.getByTestId('merge-survives').textContent).toContain('Commercial rates 2026')
  })

  it('counts one message in the singular', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    await openConfirm(TARGET_SAME_MAILBOX, { messageCount: 1 })
    expect(screen.getByRole('dialog').textContent).toMatch(/1 message\b/i)
    expect(screen.getByRole('dialog').textContent).not.toMatch(/1 messages/i)
  })

  it('does not claim "0 messages" before the thread has loaded', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    await openConfirm(TARGET_SAME_MAILBOX, { messageCount: 0 })

    // Every real ticket has a message, so 0 means "not loaded yet" — and a
    // confident wrong number is worse than a vague right one on the single
    // figure the operator is being asked to weigh.
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).not.toMatch(/0 messages/i)
    expect(dialog.textContent).toMatch(/this ticket’s messages/i)
  })

  it('does not merge when the confirm is dismissed', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    const onMerge = vi.fn(async () => ({ ok: true }))
    await openConfirm(TARGET_SAME_MAILBOX, { onMerge })

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    // Reaching the confirm step is not consent. A merge that fired on the way
    // OUT of the dialog would move a conversation the operator just declined
    // to move — and the only trace would be a ticket that vanished.
    expect(onMerge).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('merges the chosen ticket when confirmed', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    const onMerge = vi.fn(async () => ({ ok: true }))
    await openConfirm(TARGET_SAME_MAILBOX, { onMerge })

    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }))

    // Exactly the ticket that was picked. A confirm that posted the wrong id
    // would fold the conversation into a stranger's ticket.
    await waitFor(() => expect(onMerge).toHaveBeenCalledWith(TARGET_SAME_MAILBOX.id))
    expect(onMerge).toHaveBeenCalledTimes(1)
  })

  it('never offers the ticket you are already on', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    renderMerge()
    fireEvent.click(screen.getByRole('button', { name: /merge into/i }))

    // The route refuses a self-merge with a 404 that says nothing. Offering it
    // would spend a round trip to learn what the picker already knows.
    await screen.findByRole('button', { name: /Commercial rates 2026/i })
    expect(screen.queryByRole('button', { name: /Rates query/i })).toBeNull()
  })
})

describe('TicketMerge — the picker reads the whole studio queue', () => {
  it('asks for this ticket’s location and does NOT narrow to a mailbox', async () => {
    const fetchMock = stubFetch({ tickets: [SOURCE, TARGET_OTHER_MAILBOX] })
    renderMerge()
    fireEvent.click(screen.getByRole('button', { name: /merge into/i }))
    await screen.findByRole('button', { name: /Direct debit bounced/i })

    const url = new URL(
      String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/email/tickets?'))[0]),
      'http://localhost'
    )
    // The SOURCE ticket's studio, not the operator's active one — a candidate
    // at another studio is a merge the route refuses anyway.
    expect(url.searchParams.get('location_id')).toBe(LOC)
    // AND DELIBERATELY NO mailbox_id. This is the decision that makes the
    // cross-mailbox case reachable at all: TicketInbox's own list is narrowed
    // by whichever mailbox tab the operator is on, so reusing it would hide
    // exactly the duplicate they are hunting — while the confirm step's warning
    // goes on talking about a case the picker could never produce. Anyone
    // "tidying" this into the tab's list breaks that silently, so it is pinned.
    expect(url.searchParams.get('mailbox_id')).toBeNull()
  })
})

// FOCUS FOLLOWS THE STEP.
//
// The dialog swaps its entire contents between pick and confirm, so the button
// the operator just activated unmounts and the browser resolves focus to
// <body> — outside the dialog. Modal moves focus in on OPEN only (deliberately;
// re-running it on every render is the UI-MODAL-FOCUS.1 focus-steal bug) and
// has no focus trap, so nothing brings it back: a keyboard operator who picks a
// candidate with Enter lands at the top of the document and tabs through the
// whole page behind the dialog to reach Merge.
describe('TicketMerge — keyboard focus across the two steps', () => {
  it('keeps focus inside the dialog when the step changes, both ways', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    renderMerge()
    fireEvent.click(screen.getByRole('button', { name: /merge into/i }))
    const dialog = await screen.findByRole('dialog')

    // THE .focus() CALLS ARE THE TEST. jsdom's fireEvent.click does not move
    // focus to what it clicks, so without them activeElement is still the
    // Modal panel and `dialog.contains` passes on a component that has lost
    // focus completely — the assertion would be about nothing. Focusing first
    // is what a keyboard operator's Enter actually does.
    const candidate = await screen.findByRole('button', { name: /Commercial rates 2026/i })
    candidate.focus()
    fireEvent.click(candidate)
    expect(dialog.contains(document.activeElement)).toBe(true)

    // …and back again, so Back is not a one-way trip out of the dialog either.
    const back = screen.getByRole('button', { name: /back/i })
    back.focus()
    fireEvent.click(back)
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('leaves the OPENING focus to the Modal, which announces the dialog', async () => {
    // The step effect runs after Modal's own (a parent's effect flushes after
    // its children's), so firing it on open would take that announcement away.
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    renderMerge()
    fireEvent.click(screen.getByRole('button', { name: /merge into/i }))

    expect(document.activeElement).toBe(await screen.findByRole('dialog'))
  })
})

// THE WARNING THAT MUST NOT BECOME WALLPAPER.
//
// email_tickets.mailbox_id is the access unit — mig 502 keys message RLS on the
// TICKET'S mailbox — so folding accounts@ into studio@ makes the source's
// correspondence readable by everyone granted the TARGET mailbox. Merging
// across mailboxes stays ALLOWED (it is a real operator need, and the route
// permits it); the operator just has to be told. Both halves are pinned,
// because a warning that always shows is one nobody reads.
describe('TicketMerge — the cross-mailbox warning', () => {
  it('names both mailboxes and who gains access when they differ', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_OTHER_MAILBOX] })
    await openConfirm(TARGET_OTHER_MAILBOX)

    const warning = screen.getByTestId('merge-mailbox-warning')
    // BOTH addresses, so "different mailbox" is a fact the operator can check
    // rather than a claim they have to trust.
    expect(warning.textContent).toContain('accounts@un1tdublin.com')
    expect(warning.textContent).toContain('studio@un1tdublin.com')
    // And the consequence, in words: not "this crosses mailboxes" but what
    // that does — people who could not read this correspondence now can.
    expect(warning.textContent).toMatch(/will be able to read/i)

    // Informed consent, NOT a refusal. The merge stays available.
    expect(screen.getByRole('button', { name: /^merge$/i }).disabled).toBe(false)
  })

  it('shows no warning when both tickets are on the same mailbox', async () => {
    stubFetch({ tickets: [SOURCE, TARGET_SAME_MAILBOX] })
    await openConfirm(TARGET_SAME_MAILBOX)

    // The half that keeps the other half meaningful. A banner on every merge
    // is a banner the operator clicks past, and then it is not there on the
    // one merge that actually widens access.
    expect(screen.queryByTestId('merge-mailbox-warning')).toBeNull()
  })
})

describe('TicketMerge — the merged banner', () => {
  const MERGED = { ...SOURCE, merged_into_id: TARGET_SAME_MAILBOX.id }

  it('names the survivor and offers Open and Undo', async () => {
    stubFetch({ survivor: TARGET_SAME_MAILBOX })
    const onUnmerge = vi.fn(async () => ({ ok: true }))
    const onOpenTicket = vi.fn()
    renderMerge({ ticket: MERGED, onUnmerge, onOpenTicket })

    // The banner replaces the merge action: a tombstone cannot be merged
    // again (the route refuses chains, so unmerge first is the only path).
    expect(screen.queryByRole('button', { name: /merge into/i })).toBeNull()

    // It names WHERE the conversation went — the whole reason the detail route
    // keeps serving a merged ticket instead of 404ing it (EMAIL-MERGE.5).
    expect(await screen.findByText(/Commercial rates 2026/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /open/i }))
    expect(onOpenTicket).toHaveBeenCalledWith(TARGET_SAME_MAILBOX.id)

    fireEvent.click(screen.getByRole('button', { name: /undo/i }))
    await waitFor(() => expect(onUnmerge).toHaveBeenCalledTimes(1))
  })

  it('still offers Open and Undo when the survivor cannot be named', async () => {
    // The subject lookup is cosmetic. A blip on it must not strand the
    // operator on a tombstone with no way to the live thread and no way back —
    // which is exactly what hiding the banner until it resolved would do.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    renderMerge({ ticket: MERGED })

    expect(await screen.findByRole('button', { name: /undo/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /open/i })).toBeTruthy()
  })
})
