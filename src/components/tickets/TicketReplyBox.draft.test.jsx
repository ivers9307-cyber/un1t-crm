// @vitest-environment jsdom
//
// TICKET-COMPOSER-LEAK.1's remount (TicketThread keys TicketReplyBox on the
// ticket id) protects against a cross-ticket send, but paid for it with the
// draft: switching tickets mid-reply, `e` (archive auto-advances the
// selection), a refresh, or a crash all used to destroy whatever an operator
// had typed. This file pins the persistence that gets the words back
// WITHOUT touching the remount that guards the leak — see mail-display.js's
// `readReplyDraft`/`writeReplyDraft`/`clearReplyDraft` header comment for why
// per-ticket keying is what makes the two compatible.
//
// jsdom (not the default node environment) because these tests read and
// write real `window.localStorage`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import TicketReplyBox from './TicketReplyBox.jsx'
import { readReplyDraft, writeReplyDraft } from '@/components/mail/mail-display'
import { resolveViewerId } from '@/components/mail/viewer-id'

// MAIL-DRAFTSCOPE.2 — the composer resolves the signed-in user through this
// module; mocked so tests control WHO is signed in without a supabase client.
vi.mock('@/components/mail/viewer-id', () => ({
  resolveViewerId: vi.fn(),
}))

// Drafts are keyed per user + per mailbox + per ticket. The harness's default
// world: user-1 signed in, ticket-1 on mailbox mb-1 (the ticket fixture below
// carries mailbox_id so the component derives the same scope).
const S = (ticketId, userId = 'user-1', mailboxId = 'mb-1') => ({ userId, mailboxId, ticketId })

beforeEach(() => {
  resolveViewerId.mockResolvedValue('user-1')
  window.localStorage.clear()
  // Nothing here wants the network — the signature preview treats a missing
  // fetch response as cosmetic, same stub the sibling composer tests use.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

function ticket(over = {}) {
  return { id: 'ticket-1', subject: 'Membership freeze', requester_email: 'a@x.com', status: 'open', mailbox_id: 'mb-1', ...over }
}

function renderBox(props = {}) {
  return render(
    <TicketReplyBox
      ticket={ticket()}
      replyRecipients={{ to: ['a@x.com'], mode: 'reply', over_cap: false, empty: false }}
      onSend={vi.fn()}
      signature=""
      onRemoveRecipient={vi.fn()}
      onRestoreRecipient={vi.fn()}
      {...props}
    />
  )
}

describe('TicketReplyBox — draft persistence', () => {
  it('hydrates a saved draft on mount, invisibly — no banner, just the text', async () => {
    writeReplyDraft(S('ticket-1'), { text: 'Sorry for the delay', mode: 'reply' })
    renderBox()
    // Hydration waits for the viewer id to resolve (MAIL-DRAFTSCOPE.2), so it
    // lands a microtask after mount rather than synchronously.
    await waitFor(() => expect(screen.getByLabelText('Reply to the member').value).toBe('Sorry for the delay'))
    // No affordance announcing a restore — the task is explicit that a
    // restored draft must be visibly just… there.
    expect(screen.queryByText(/restored/i)).toBeNull()
  })

  it('restores note mode along with the text, not just reply mode', async () => {
    writeReplyDraft(S('ticket-1'), { text: 'Staff-only context', mode: 'note' })
    renderBox()
    await waitFor(() => expect(screen.getByLabelText('Internal note (staff only)').value).toBe('Staff-only context'))
    expect(screen.getByRole('button', { name: 'Internal note' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('starts blank when nothing was saved for this ticket', () => {
    renderBox()
    expect(screen.getByLabelText('Reply to the member').value).toBe('')
  })

  it('writes the draft through as the operator types', async () => {
    renderBox()
    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'Working on it' } })
    await waitFor(() => {
      expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'Working on it', mode: 'reply' })
    })
  })

  it('writes the mode through too, so a switch to note mode survives a reload', async () => {
    renderBox()
    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'draft text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }))
    await waitFor(() => {
      expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'draft text', mode: 'note' })
    })
  })

  it('clears the stored draft only once the send actually succeeds', async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: true })
    renderBox({ onSend })
    const box = screen.getByLabelText('Reply to the member')
    fireEvent.change(box, { target: { value: 'Sending this now' } })
    await waitFor(() => expect(readReplyDraft(S('ticket-1'))).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    await waitFor(() => expect(readReplyDraft(S('ticket-1'))).toBeNull())
    expect(screen.getByLabelText('Reply to the member').value).toBe('')
  })

  it('keeps the draft when the send fails or is left unfiled', async () => {
    // EMAIL-REPLY-UNFILED.1: `result.sent` with no `.ok` means the mail went
    // out but the thread could not record it — the words in the box are the
    // operator's only copy, and they must not vanish here either.
    const onSend = vi.fn().mockResolvedValue({ sent: true })
    renderBox({ onSend })
    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'Went out, unfiled' } })
    await waitFor(() => expect(readReplyDraft(S('ticket-1'))).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'Went out, unfiled', mode: 'reply' })
  })

  // 🔴 THE ISOLATION GUARANTEE, one component up from mail-display.test.js.
  // A remount (the real TicketThread mechanism) must load the NEW ticket's
  // own draft, never the ticket that was just left.
  it('never shows one ticket’s draft under another ticket — even across a remount', async () => {
    writeReplyDraft(S('ticket-A'), { text: 'For A only', mode: 'reply' })
    writeReplyDraft(S('ticket-B'), { text: 'For B only', mode: 'reply' })

    const { rerender } = render(
      <TicketReplyBox
        key="ticket-A"
        ticket={ticket({ id: 'ticket-A' })}
        replyRecipients={{ to: ['a@x.com'], mode: 'reply', over_cap: false, empty: false }}
        onSend={vi.fn()}
        signature=""
      />
    )
    await waitFor(() => expect(screen.getByLabelText('Reply to the member').value).toBe('For A only'))

    // A different `key` is what TicketThread actually does — this is the
    // remount TICKET-COMPOSER-LEAK.1 relies on, exercised for real rather
    // than assumed.
    rerender(
      <TicketReplyBox
        key="ticket-B"
        ticket={ticket({ id: 'ticket-B' })}
        replyRecipients={{ to: ['b@y.com'], mode: 'reply', over_cap: false, empty: false }}
        onSend={vi.fn()}
        signature=""
      />
    )
    await waitFor(() => expect(screen.getByLabelText('Reply to the member').value).toBe('For B only'))
    expect(screen.queryByDisplayValue('For A only')).toBeNull()
  })

  it('does not write a draft back for a ticket with nothing typed on mount', () => {
    // Mounting must not itself create a localStorage entry — only real
    // operator input (or an existing draft) should ever produce one.
    renderBox()
    expect(readReplyDraft(S('ticket-1'))).toBeNull()
  })
})

describe('TicketReplyBox — draft scoping (MAIL-DRAFTSCOPE.2)', () => {
  beforeEach(() => {
    resolveViewerId.mockResolvedValue('user-1')
    window.localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  const mount = (over = {}) => render(
    <TicketReplyBox
      ticket={{ id: 'ticket-1', subject: 'S', requester_email: 'a@x.com', status: 'open', mailbox_id: 'mb-1' }}
      replyRecipients={{ to: ['a@x.com'], mode: 'reply', over_cap: false, empty: false }}
      onSend={vi.fn()}
      signature=""
      {...over}
    />
  )

  // 🔴 The reason this scope exists: staff-A's half-written reply must never
  // hydrate into staff-B's composer on a shared browser.
  it('never hydrates another user\'s draft for the same ticket', async () => {
    writeReplyDraft(S('ticket-1', 'staff-a'), { text: 'A\'s private words', mode: 'reply' })
    resolveViewerId.mockResolvedValue('staff-b')

    mount()

    // Give hydration its microtasks, then assert the box stayed empty.
    await waitFor(() => expect(resolveViewerId).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    expect(screen.getByLabelText('Reply to the member').value).toBe('')
  })

  // 🔴 FAIL CLOSED: no resolvable user → no persistence at all, never an
  // unscoped key another signed-in user could hydrate.
  it('persists nothing when the viewer cannot be resolved', async () => {
    resolveViewerId.mockResolvedValue(null)
    mount()
    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'no home for this' } })
    await new Promise(r => setTimeout(r, 30))
    expect(window.localStorage.length).toBe(0)
  })

  // Hydration is async; an operator can outrun it. Their live words must win
  // over the stored draft — the first cut erased them mid-sentence.
  it('keeps live typing over a stored draft when typing outran hydration', async () => {
    writeReplyDraft(S('ticket-1'), { text: 'the old stored draft', mode: 'reply' })
    // A viewer id that resolves late, AFTER the operator has typed.
    let release
    resolveViewerId.mockReturnValue(new Promise(r => { release = r }))

    mount()
    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'live words, mid-sentence' } })
    release('user-1')

    // The live text survives…
    await new Promise(r => setTimeout(r, 30))
    expect(screen.getByLabelText('Reply to the member').value).toBe('live words, mid-sentence')
    // …and is persisted now that the scope exists, replacing the stored draft.
    await waitFor(() => expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'live words, mid-sentence', mode: 'reply' }))
  })

  // The skip must be spent by the time hydration settles with NO draft —
  // otherwise it swallows the write of the first post-hydration keystroke.
  // The live-typing branch masks this in the other tests (it writes directly),
  // so this one waits hydration OUT before typing anything.
  it('persists the first keystroke typed AFTER hydration found nothing', async () => {
    mount()
    await waitFor(() => expect(resolveViewerId).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))

    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'first words' } })

    await waitFor(() => expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'first words', mode: 'reply' }))
  })

  it('scopes by the ticket\'s mailbox — same ticket id under another account is a different draft', async () => {
    writeReplyDraft(S('ticket-1', 'user-1', 'mb-other'), { text: 'belongs to the other account', mode: 'reply' })
    mount() // ticket fixture is mb-1
    await waitFor(() => expect(resolveViewerId).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    expect(screen.getByLabelText('Reply to the member').value).toBe('')
  })
})
