// @vitest-environment jsdom
//
// MAIL-DOCK.1 — the collapsed composer (the mockup's slim pill).
//
// The pill is a RESTING state of the same composer, not a second composer:
// every hook — viewer resolution, draft hydration, write-through — runs
// identically whether the form is showing or not. What this file pins:
//   • default callers keep the always-open form byte-for-byte (the ticket
//     surface's own tests never pass startCollapsed);
//   • the pill names the requester by FIRST name and expands on click,
//     focusing the textarea — a click that leaves focus on a vanished button
//     strands the next keystroke where the j/k/e shortcuts live;
//   • Note expands straight into note mode;
//   • 🔴 a saved draft auto-expands (words already written must never hide
//     behind a bar that looks blank) but does NOT steal focus — auto-expand
//     fires on every j/k step onto a drafted conversation, and focusing
//     there would turn the next j into a letter typed into the draft;
//   • draft write-through works from a pill-expanded composer, so the pill
//     cannot reopen the lost-words bug the draft store closed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import TicketReplyBox from './TicketReplyBox.jsx'
import { readReplyDraft, writeReplyDraft } from '@/components/mail/mail-display'
import { resolveViewerId } from '@/components/mail/viewer-id'

vi.mock('@/components/mail/viewer-id', () => ({
  resolveViewerId: vi.fn(),
}))

const S = (ticketId, userId = 'user-1', mailboxId = 'mb-1') => ({ userId, mailboxId, ticketId })

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

function ticket(over = {}) {
  return {
    id: 'ticket-1',
    subject: 'Membership freeze',
    requester_email: 'helen@member.ie',
    requester_name: 'Helen Lawlor',
    status: 'open',
    mailbox_id: 'mb-1',
    ...over,
  }
}

function renderBox(props = {}) {
  return render(
    <TicketReplyBox
      ticket={ticket()}
      replyRecipients={{ to: ['helen@member.ie'], mode: 'reply', over_cap: false, empty: false }}
      onSend={vi.fn()}
      signature=""
      onRemoveRecipient={vi.fn()}
      onRestoreRecipient={vi.fn()}
      {...props}
    />
  )
}

const composer = () => document.getElementById('ticket-composer')

describe('TicketReplyBox — without startCollapsed nothing changed', () => {
  it('renders the full form immediately, no pill', () => {
    renderBox()
    expect(composer()).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reply ↵' })).toBeNull()
  })
})

describe('TicketReplyBox — the slim pill', () => {
  it('renders as the bar — first name, Note, Reply ↵ — with no textarea yet', () => {
    renderBox({ startCollapsed: true })
    expect(screen.getByRole('button', { name: 'Reply to Helen…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Note' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reply ↵' })).toBeTruthy()
    expect(composer()).toBeNull()
  })

  it('expands on click and focuses the textarea', () => {
    renderBox({ startCollapsed: true })
    fireEvent.click(screen.getByRole('button', { name: 'Reply ↵' }))
    expect(composer()).toBeTruthy()
    expect(document.activeElement).toBe(composer())
    // Reply mode, exactly as the button said.
    expect(screen.getByRole('button', { name: 'Reply to member' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('the label is as much the button as Reply ↵ is', () => {
    renderBox({ startCollapsed: true })
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Helen…' }))
    expect(composer()).toBeTruthy()
    expect(document.activeElement).toBe(composer())
  })

  it('Note expands straight into note mode', () => {
    renderBox({ startCollapsed: true })
    fireEvent.click(screen.getByRole('button', { name: 'Note' }))
    expect(composer()).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Internal note' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/Staff only —/)).toBeTruthy()
  })

  it('🔴 a saved draft auto-expands the pill — without stealing focus', async () => {
    writeReplyDraft(S('ticket-1'), { text: 'Half-written already', mode: 'reply' })
    renderBox({ startCollapsed: true })
    await waitFor(() => expect(composer()).toBeTruthy())
    expect(composer().value).toBe('Half-written already')
    expect(document.activeElement).not.toBe(composer())
  })

  it('no draft: the pill stays collapsed once hydration settles', async () => {
    renderBox({ startCollapsed: true })
    // Let the viewer resolution + hydration effect land.
    await waitFor(() => expect(resolveViewerId).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(composer()).toBeNull()
    expect(screen.getByRole('button', { name: 'Reply to Helen…' })).toBeTruthy()
  })

  it('write-through still works from a pill-expanded composer', async () => {
    renderBox({ startCollapsed: true })
    fireEvent.click(screen.getByRole('button', { name: 'Reply ↵' }))
    fireEvent.change(composer(), { target: { value: 'Morning Helen' } })
    await waitFor(() => {
      expect(readReplyDraft(S('ticket-1'))).toEqual({ text: 'Morning Helen', mode: 'reply' })
    })
  })

  it('falls back to the address, then to a bare Reply…, when there is no name', () => {
    renderBox({ startCollapsed: true, ticket: ticket({ requester_name: null }) })
    expect(screen.getByRole('button', { name: 'Reply to helen@member.ie…' })).toBeTruthy()
    cleanup()
    renderBox({ startCollapsed: true, ticket: ticket({ requester_name: null, requester_email: null }) })
    expect(screen.getByRole('button', { name: 'Reply…' })).toBeTruthy()
  })
})
