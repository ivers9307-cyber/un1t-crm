// @vitest-environment jsdom
//
// MAIL-READER.1 — the reader header, compacted.
//
// The card is 78vh. It was spending three stacked rows on chrome before the
// first word of the email: the subject line, a row of three labelled buttons
// with the whole keyboard-shortcut cheat sheet trailing off the end of it, and
// a full-width blue banner about a DIFFERENT conversation. What this file pins:
//
//   • the three actions are ICONS on the subject's own line. The words did not
//     vanish — they moved to aria-label and title, so the button a screen
//     reader announces and the tooltip a mouse finds are the same words the
//     row used to print, and every existing test that asked for a button "by
//     name" still finds it.
//   • the cheat sheet is a tooltip on a "?" button, not a sentence. An
//     undiscoverable shortcut is the same as no shortcut (MailControls' own
//     rule), and a tooltip is discoverable; a paragraph nobody reads twice is
//     not worth a row of a 78vh card.
//   • the related-conversation nudge is a CHIP on the participants line. Same
//     data, same two actions, same role="status" — it just stops being a
//     full-width bar shoved between the header and the email.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import MailThread from './MailThread.jsx'
import { MAIL_SHORTCUTS } from './mail-vocabulary'

const CONVERSATION = {
  id: 'a0000000-0000-4000-8000-00000000000a',
  status: 'open',
  subject: 'Flogas bill for Hatch Street',
  requester_email: 'jordan.sample@example.test',
  requester_name: 'Jordan Sample',
  mailbox: { id: 'mb-1', label: 'Accounts', address: 'accounts@hatch.ie' },
  needs_reply: true,
  archived: false,
  unread: false,
}

const MESSAGE = {
  id: 'm-1',
  direction: 'inbound',
  from_email: 'jordan.sample@example.test',
  to_emails: ['accounts@hatch.ie'],
  text_body: 'Just following up on the meter read.',
  created_at: '2026-08-31T08:00:00Z',
}

const OPEN_RELATED = {
  id: 'r-open-1',
  subject: 'RE: Meter reading — urgent',
  status: 'open',
  message_count: 2,
  last_message_at: '2026-08-28T12:00:00Z',
  requester_name: 'Jordan Sample',
}

function stubNetwork(related) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/related')) {
      return { ok: true, status: 200, json: async () => related }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  }))
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  stubNetwork({ success: true, data: { related: [], open_count: 0 } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderThread(props = {}) {
  return render(
    <MailThread
      hasSelection
      conversation={CONVERSATION}
      messages={[MESSAGE]}
      onBack={() => {}}
      onSend={() => {}}
      onArchive={() => {}}
      onSpam={() => {}}
      onMarkRead={() => {}}
      onMarkUnread={() => {}}
      onOpenConversation={() => {}}
      {...props}
    />
  )
}

describe('MailThread — icon-only controls', () => {
  it.each([
    ['Archive', false],
    ['Mark as spam', false],
    ['Mark unread', false],
  ])('keeps "%s" as the accessible name and the tooltip, with no printed label', (name) => {
    renderThread()
    const btn = screen.getByRole('button', { name })
    expect(btn.getAttribute('aria-label')).toBe(name)
    expect(btn.getAttribute('title')).toBe(name)
    // Icon-only: an <svg> and nothing readable.
    expect(btn.textContent.trim()).toBe('')
  })

  it('flips to the reverse labels in the reverse states', () => {
    renderThread({ conversation: { ...CONVERSATION, archived: true, status: 'closed', is_spam: true, unread: true } })
    expect(screen.getByRole('button', { name: 'Move back to inbox' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not spam' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeTruthy()
  })

  it('sits on the subject’s own line, not a row beneath it', () => {
    renderThread()
    const subject = screen.getByRole('heading', { name: CONVERSATION.subject })
    const headerRow = subject.closest('.flex.items-start')
    expect(headerRow).toBeTruthy()
    expect(headerRow.contains(screen.getByRole('button', { name: 'Archive' }))).toBe(true)
  })
})

describe('MailThread — the shortcut hint is a tooltip', () => {
  const HINT = MAIL_SHORTCUTS.map(s => `${s.keys} · ${s.description}`).join('   ')

  it('hangs the cheat sheet off a "?" button instead of printing it', () => {
    renderThread()
    const help = screen.getByRole('button', { name: 'Keyboard shortcuts' })
    expect(help.getAttribute('title')).toBe(HINT)
    expect(help.getAttribute('type')).toBe('button')
  })

  it('no longer spends a row of the card on the sentence', () => {
    renderThread()
    expect(screen.queryByText(HINT)).toBeNull()
  })
})

describe('MailThread — the nudge is a chip, not a banner', () => {
  it('renders inline in the header with the same data and the same two actions', async () => {
    stubNetwork({ success: true, data: { related: [OPEN_RELATED], open_count: 1 } })
    renderThread()

    const chip = await screen.findByRole('status')
    expect(chip.textContent).toContain('Jordan Sample')
    expect(chip.textContent).toContain('1 other open conversation')
    expect(chip.contains(screen.getByRole('button', { name: 'View' }))).toBe(true)
    expect(chip.contains(screen.getByRole('button', { name: 'Merge into this one' }))).toBe(true)

    // Chip styling, and NOT the full-width bar it replaced.
    expect(chip.className).toContain('rounded-full')
    expect(chip.className).toContain('bg-blue-500/10')
    expect(chip.className).toContain('text-[11px]')
    expect(chip.className).not.toContain('border-b')
  })

  it('lives inside the header column, under the participants line', async () => {
    stubNetwork({ success: true, data: { related: [OPEN_RELATED], open_count: 1 } })
    renderThread()
    const chip = await screen.findByRole('status')
    const subject = screen.getByRole('heading', { name: CONVERSATION.subject })
    // The header's min-w-0 flex-1 column holds the subject AND the chip.
    const column = subject.closest('.min-w-0')
    expect(column.contains(chip)).toBe(true)
  })

  it('stays absent when there is nothing related', async () => {
    renderThread()
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })
})
