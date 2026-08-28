// @vitest-environment jsdom
//
// INBOX-SURFACE.E — the tickets surface must stop lying after a mailbox
// moves to Mail.
//
// Today, once a studio's only mailbox flips `email_mailboxes.surface` to
// 'inbox' (Mail), the tickets route's visible set narrows to nothing and
// TicketInbox falls into NO_MAILBOX_EMPTY — "no addresses set up, or you
// have not been given access". Both halves false for a deliberate move: the
// operator still has access and the studio still has email, it is just
// answered on a different surface now. The list response's
// `mailboxes_on_mail` (the tickets route's own field, INBOX-SURFACE contract)
// says which account(s) moved, and this is where that gets rendered honestly
// instead of falling through to the generic empty state.
//
// Narrow, through the real TicketInbox, on the mock-fetch harness
// TicketInbox.race.test.jsx established — this file only exercises the
// queue-load → empty-state branch, so no thread fetch is ever needed (an
// empty mailbox list short-circuits before any row can be selected).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import TicketInbox from './TicketInbox.jsx'

function jsonResponse(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}

/** Flush every pending microtask chain (fetch → json → setState). */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function stubFetch(queueBody) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).startsWith('/api/email/tickets?')) {
      return Promise.resolve(jsonResponse(queueBody))
    }
    throw new Error(`unexpected fetch in this suite: ${url}`)
  }))
}

function inbox() {
  return <TicketInbox locationId="loc-1" locationName="Hatch Street" userId="staff-1" />
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TicketInbox — mailboxes_on_mail empty state (INBOX-SURFACE.E)', () => {
  it('renders NO_MAILBOX_EMPTY when mailboxes_on_mail is [] — the genuinely-nothing case', async () => {
    stubFetch({ success: true, data: { mailboxes: [], tickets: [], mailboxes_on_mail: [] } })
    render(inbox())
    await flush()
    expect(screen.getByText('No email accounts available here')).toBeTruthy()
    expect(screen.queryByText(/answered on Mail/)).toBeNull()
  })

  it('renders NO_MAILBOX_EMPTY when mailboxes_on_mail is ABSENT — old server during deploy skew, treated exactly like []', async () => {
    stubFetch({ success: true, data: { mailboxes: [], tickets: [] } }) // no mailboxes_on_mail key at all
    render(inbox())
    await flush()
    // Must not crash on the missing field, and must fall back to the honest
    // "genuinely nothing" copy rather than silently rendering neither.
    expect(screen.getByText('No email accounts available here')).toBeTruthy()
  })

  it('renders the moved-to-Mail copy, naming the account, when the tickets set is empty but mailboxes_on_mail is not', async () => {
    stubFetch({
      success: true,
      data: { mailboxes: [], tickets: [], mailboxes_on_mail: ['accounts@hatchstreetfitness.com'] },
    })
    render(inbox())
    await flush()
    expect(screen.queryByText('No email accounts available here')).toBeNull()
    expect(screen.getByText(/accounts@hatchstreetfitness\.com/)).toBeTruthy()
    expect(screen.getAllByText(/answered on Mail/).length).toBeGreaterThan(0)
  })

  it('links to /communications/mail with a real Next Link, not a bare anchor onClick', async () => {
    stubFetch({
      success: true,
      data: { mailboxes: [], tickets: [], mailboxes_on_mail: ['Accounts'] },
    })
    render(inbox())
    await flush()
    const link = screen.getByRole('link', { name: /Mail/i })
    expect(link.getAttribute('href')).toBe('/communications/mail')
  })

  it('does NOT hide the surface or otherwise change populated-state behaviour when mailboxes ARE present', async () => {
    const MAILBOX = { id: 'mb-1', label: 'Front desk', address: 'hello@example.com', is_default: true }
    stubFetch({
      success: true,
      data: { mailboxes: [MAILBOX], tickets: [], mailboxes_on_mail: ['Sales moved away'] },
    })
    render(inbox())
    await flush()
    // A populated mailbox list must render the normal shell (New email
    // compose lives here), never the empty-state branch — even though
    // mailboxes_on_mail is non-empty in this payload (some OTHER account
    // moved; this studio's remaining tickets mailbox is still live).
    expect(screen.queryByText(/answered on Mail/)).toBeNull()
    expect(screen.getByRole('button', { name: /New email/i })).toBeTruthy()
  })
})

// AUDIT #4 — BLOCKING fix. scopeToVisibleMailboxes (src/app/api/email/tickets/
// _helpers.js) deliberately keeps returning NULL-mailbox (orphan) tickets to
// an ELEVATED caller even when every mailbox has moved to Mail — its own
// header comment calls a vanishing record "the one outcome this split must
// never produce". The bug: TicketInbox rendered the full-screen empty state
// the instant `mailboxes.length === 0`, BEFORE ever looking at `tickets` — so
// an owner with an orphaned ticket (mailbox deleted, ON DELETE SET NULL; or
// predating mig 484's backfill) saw "answered on Mail… open Mail" while the
// orphan sat in the very `tickets` array behind that early return, AND the
// Mail surface explicitly excludes orphans (INBOX-SURFACE.C's own comment) —
// so the record was reachable from NO surface, with copy pointing at the
// wrong one. Reachable at exactly the flip Richard is about to make.
//
// Fix: the full-screen empty state additionally requires `tickets.length ===
// 0`. Whenever mailboxes is empty but tickets is NOT, the ordinary populated
// list renders (empty tab strip and all — TicketList/TicketCompose already
// degrade to "no real choice" at zero mailboxes, verified below), with the
// moved-accounts pointer kept alive as a slim banner rather than suppressed.
describe('TicketInbox — orphan tickets survive an all-moved mailbox set (AUDIT #4)', () => {
  const ORPHAN_ROW = {
    id: 'ticket-orphan', requester_name: 'Nora Orphan', requester_email: 'nora@example.com',
    subject: 'Old billing thread', status: 'open', unread_count: 0, mailbox_id: null,
    last_message_at: '2026-08-20T00:00:00Z',
  }

  it('renders the orphan ticket row instead of the full-screen empty state, for an elevated caller', async () => {
    stubFetch({
      success: true,
      data: {
        mailboxes: [],
        tickets: [ORPHAN_ROW],
        mailboxes_on_mail: ['accounts@hatchstreetfitness.com'],
        viewer_is_elevated: true,
      },
    })
    render(inbox())
    await flush()
    // No full-screen empty state of EITHER flavour — the record must be
    // reachable, not explained away.
    expect(screen.queryByText('No email accounts available here')).toBeNull()
    // The orphan itself is on screen.
    expect(screen.getByText('Nora Orphan')).toBeTruthy()
    expect(screen.getByText('Old billing thread')).toBeTruthy()
  })

  it('keeps the moved-accounts pointer to Mail visible alongside the orphan row, not suppressed by it', async () => {
    stubFetch({
      success: true,
      data: {
        mailboxes: [],
        tickets: [ORPHAN_ROW],
        mailboxes_on_mail: ['accounts@hatchstreetfitness.com'],
        viewer_is_elevated: true,
      },
    })
    render(inbox())
    await flush()
    expect(screen.getByText('Nora Orphan')).toBeTruthy()
    // The pointer to Mail must survive in some form (banner, not full-screen
    // takeover) — this is the half the full-screen branch used to own alone.
    expect(screen.getByText(/accounts@hatchstreetfitness\.com/)).toBeTruthy()
    const link = screen.getByRole('link', { name: /Mail/i })
    expect(link.getAttribute('href')).toBe('/communications/mail')
  })

  it('does not crash rendering an empty tab strip / mailbox header when mailboxes is [] but tickets is not', async () => {
    stubFetch({
      success: true,
      data: {
        mailboxes: [],
        tickets: [ORPHAN_ROW],
        mailboxes_on_mail: ['accounts@hatchstreetfitness.com'],
        viewer_is_elevated: true,
      },
    })
    render(inbox())
    await flush()
    // The single-mailbox header branch (mailboxes.length <= 1) degrades to
    // "Email" with no address chip when mailboxes[0] does not exist — no
    // tab strip, no crash. New email compose is still offered (TicketCompose
    // itself already disables Send with no mailbox to pick).
    expect(screen.getByText('Email')).toBeTruthy()
    expect(screen.getByRole('button', { name: /New email/i })).toBeTruthy()
  })

  it('still shows the genuinely-empty state when tickets is [] too, even for an elevated caller', async () => {
    stubFetch({
      success: true,
      data: { mailboxes: [], tickets: [], mailboxes_on_mail: [], viewer_is_elevated: true },
    })
    render(inbox())
    await flush()
    expect(screen.getByText('No email accounts available here')).toBeTruthy()
  })

  it('still shows the moved-to-Mail empty state when tickets is [] but mailboxes_on_mail is not, even for an elevated caller', async () => {
    stubFetch({
      success: true,
      data: {
        mailboxes: [], tickets: [], mailboxes_on_mail: ['Accounts'], viewer_is_elevated: true,
      },
    })
    render(inbox())
    await flush()
    expect(screen.getAllByText(/answered on Mail/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Nora Orphan')).toBeNull()
  })

  it('a non-elevated caller (route returns no orphans) still gets the unchanged empty state', async () => {
    // The route never hands a non-elevated caller a NULL-mailbox row — this
    // pins the CLIENT side of that contract: tickets legitimately empty here
    // means the full-screen empty state is still correct.
    stubFetch({
      success: true,
      data: {
        mailboxes: [], tickets: [], mailboxes_on_mail: ['accounts@hatchstreetfitness.com'],
        viewer_is_elevated: false,
      },
    })
    render(inbox())
    await flush()
    // The full-screen moved-to-Mail empty state, not the populated shell —
    // there is genuinely nothing (no orphans, no mailboxes) for this caller.
    expect(screen.getAllByText(/answered on Mail/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /New email/i })).toBeNull()
  })
})
