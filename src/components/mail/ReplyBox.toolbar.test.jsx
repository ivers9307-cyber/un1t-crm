// @vitest-environment jsdom
//
// MAIL-READER.1 — the reader card shows the EMAIL, not the chrome.
//
// The composer used to spend four rows of a 78vh card on things nobody reads
// twice: a dashed box reprinting the whole signature, and a sentence naming
// every recipient again under a box that already lists them as chips. Both are
// gone from the surface. What replaces them:
//
//   • NO signature preview in any composer. The signature is configured on the
//     account page and previewed there; three composers reprinting it was the
//     same text in four places, and the one place it is EDITABLE is the one
//     that keeps the preview.
//   • The audience sentence moves to the Send button's tooltip and an sr-only
//     description — nobody loses the information, it just stops occupying the
//     card. It is still exact: cc, bcc-as-private, and the reply-to address.
//   • What STAYS visible is anything that changes what the button does: the
//     note-mode warning (this is not sent to the member) and the reasons a
//     disabled button is disabled.
//
// The 40%-of-the-card cap on the form is layout, so it is asserted here only
// as the class recipe — jsdom has no layout engine and would happily pass a
// composer that fills the whole card (a recorded trap).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import ReplyBox from './ReplyBox.jsx'
import { resolveViewerId } from '@/components/mail/viewer-id'

vi.mock('@/components/mail/viewer-id', () => ({ resolveViewerId: vi.fn() }))

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

const CONVERSATION = {
  id: 'conversation-1',
  subject: 'Membership freeze',
  requester_email: 'helen@member.ie',
  requester_name: 'Helen Lawlor',
  status: 'open',
  mailbox_id: 'mb-1',
  location_id: 'loc-still',
  mailbox: { id: 'mb-1', label: 'Front desk', address: 'hello@stillorgan.ie' },
}

function renderBox(props = {}) {
  return render(
    <ReplyBox
      conversation={CONVERSATION}
      replyRecipients={{ to: ['helen@member.ie'], mode: 'reply', over_cap: false, empty: false }}
      onSend={() => ({ ok: true })}
      {...props}
    />
  )
}

// The submit button, never the "Reply to member" mode pill beside it.
function sendButton() {
  return document.querySelector('form button[type="submit"]')
}

describe('ReplyBox — no signature preview', () => {
  it('never prints the signature under the textarea', () => {
    renderBox()
    expect(screen.queryByText(/added automatically/i)).toBeNull()
    expect(screen.queryByText(/Edit signature/i)).toBeNull()
    expect(document.querySelector('pre')).toBeNull()
  })

  it('does not even ask for it — the preferences GET is the hint’s, and the hint is gone', () => {
    renderBox()
    const asked = global.fetch.mock.calls.some(([url]) => String(url).includes('/api/me/preferences'))
    expect(asked).toBe(false)
  })
})

describe('ReplyBox — one toolbar row', () => {
  it('moves the audience sentence off the surface and onto the Send button', () => {
    renderBox({
      replyRecipients: { to: ['helen@member.ie', 'gym@example.com'], mode: 'reply_all', over_cap: false, empty: false },
    })

    // Off the SURFACE: the only element still carrying the sentence is the
    // screen-reader description, which occupies no space.
    const carriers = screen.queryAllByText(/^Sends an email to/)
    expect(carriers).toHaveLength(1)
    expect(carriers[0].className).toContain('sr-only')

    const btn = sendButton()
    expect(btn.getAttribute('title')).toContain('Sends an email to helen@member.ie, gym@example.com')
    expect(btn.getAttribute('title')).toContain('replies come back to hello@stillorgan.ie')
  })

  it('keeps the same sentence for screen readers, tied to the button', () => {
    renderBox()
    const btn = sendButton()
    const describedBy = btn.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const description = document.getElementById(describedBy)
    expect(description).toBeTruthy()
    expect(description.className).toContain('sr-only')
    expect(description.textContent).toBe(btn.getAttribute('title'))
  })

  it('names cc, and names bcc as hidden from everyone else', () => {
    renderBox()
    fireEvent.click(screen.getByRole('button', { name: 'Cc / Bcc' }))
    const cc = screen.getByLabelText('Cc')
    fireEvent.change(cc, { target: { value: 'boss@example.com' } })
    fireEvent.blur(cc)

    expect(sendButton().getAttribute('title')).toContain('cc boss@example.com')
  })

  it('puts the attachment control and Send in the same row', () => {
    renderBox()
    const attach = screen.getByRole('button', { name: /Attach files/i })
    const row = attach.closest('[data-composer-toolbar]')
    expect(row).toBeTruthy()
    expect(row.contains(sendButton())).toBe(true)
  })
})

describe('ReplyBox — what stays visible', () => {
  it('keeps the note-mode warning on the surface: it changes what the button does', () => {
    renderBox()
    fireEvent.click(screen.getByRole('button', { name: /Internal note/i }))
    expect(screen.getByText(/Staff only —/)).toBeTruthy()
    expect(screen.getByText('not sent')).toBeTruthy()
  })

  it('keeps the emptied-audience line — it explains a disabled button', () => {
    renderBox({ replyRecipients: { to: [], mode: 'reply', over_cap: false, empty: true } })
    expect(screen.getByText(/no recipients left/i)).toBeTruthy()
  })

  it('keeps the no-sender-address line', () => {
    renderBox({ conversation: { ...CONVERSATION, requester_email: null } })
    expect(screen.getByText(/no sender address/i)).toBeTruthy()
  })
})

describe('ReplyBox — bounded height (class recipe only; jsdom cannot see layout)', () => {
  it('caps the expanded form and lets it scroll, with the textarea free to grow', () => {
    const { container } = renderBox()
    const form = container.querySelector('form')
    expect(form.className).toContain('max-h-[40%]')
    expect(form.className).toContain('overflow-y-auto')
    expect(screen.getByLabelText(/Reply to the member/i).getAttribute('rows')).toBe('4')
  })
})
