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

beforeEach(() => {
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
  return { id: 'ticket-1', subject: 'Membership freeze', requester_email: 'a@x.com', status: 'open', ...over }
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
  it('hydrates a saved draft on mount, invisibly — no banner, just the text', () => {
    writeReplyDraft('ticket-1', { text: 'Sorry for the delay', mode: 'reply' })
    renderBox()
    expect(screen.getByLabelText('Reply to the member').value).toBe('Sorry for the delay')
    // No affordance announcing a restore — the task is explicit that a
    // restored draft must be visibly just… there.
    expect(screen.queryByText(/restored/i)).toBeNull()
  })

  it('restores note mode along with the text, not just reply mode', () => {
    writeReplyDraft('ticket-1', { text: 'Staff-only context', mode: 'note' })
    renderBox()
    expect(screen.getByLabelText('Internal note (staff only)').value).toBe('Staff-only context')
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
      expect(readReplyDraft('ticket-1')).toEqual({ text: 'Working on it', mode: 'reply' })
    })
  })

  it('writes the mode through too, so a switch to note mode survives a reload', async () => {
    renderBox()
    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'draft text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }))
    await waitFor(() => {
      expect(readReplyDraft('ticket-1')).toEqual({ text: 'draft text', mode: 'note' })
    })
  })

  it('clears the stored draft only once the send actually succeeds', async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: true })
    renderBox({ onSend })
    const box = screen.getByLabelText('Reply to the member')
    fireEvent.change(box, { target: { value: 'Sending this now' } })
    await waitFor(() => expect(readReplyDraft('ticket-1')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    await waitFor(() => expect(readReplyDraft('ticket-1')).toBeNull())
    expect(screen.getByLabelText('Reply to the member').value).toBe('')
  })

  it('keeps the draft when the send fails or is left unfiled', async () => {
    // EMAIL-REPLY-UNFILED.1: `result.sent` with no `.ok` means the mail went
    // out but the thread could not record it — the words in the box are the
    // operator's only copy, and they must not vanish here either.
    const onSend = vi.fn().mockResolvedValue({ sent: true })
    renderBox({ onSend })
    fireEvent.change(screen.getByLabelText('Reply to the member'), { target: { value: 'Went out, unfiled' } })
    await waitFor(() => expect(readReplyDraft('ticket-1')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(readReplyDraft('ticket-1')).toEqual({ text: 'Went out, unfiled', mode: 'reply' })
  })

  // 🔴 THE ISOLATION GUARANTEE, one component up from mail-display.test.js.
  // A remount (the real TicketThread mechanism) must load the NEW ticket's
  // own draft, never the ticket that was just left.
  it('never shows one ticket’s draft under another ticket — even across a remount', () => {
    writeReplyDraft('ticket-A', { text: 'For A only', mode: 'reply' })
    writeReplyDraft('ticket-B', { text: 'For B only', mode: 'reply' })

    const { rerender } = render(
      <TicketReplyBox
        key="ticket-A"
        ticket={ticket({ id: 'ticket-A' })}
        replyRecipients={{ to: ['a@x.com'], mode: 'reply', over_cap: false, empty: false }}
        onSend={vi.fn()}
        signature=""
      />
    )
    expect(screen.getByLabelText('Reply to the member').value).toBe('For A only')

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
    expect(screen.getByLabelText('Reply to the member').value).toBe('For B only')
    expect(screen.queryByDisplayValue('For A only')).toBeNull()
  })

  it('does not write a draft back for a ticket with nothing typed on mount', () => {
    // Mounting must not itself create a localStorage entry — only real
    // operator input (or an existing draft) should ever produce one.
    renderBox()
    expect(readReplyDraft('ticket-1')).toBeNull()
  })
})
