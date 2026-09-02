// @vitest-environment jsdom
//
// MAIL-DOCK.1 — the email frame's height follows its WINDOW.
//
// The sandboxed iframe cannot report its own height (no scripts — the whole
// point), so it gets a fixed box. That box is now context-sized via
// `frameSize` (dock/full), and the operator's Expand choice persists in
// localStorage ('un1t.mail.body-expanded').
//
// 🔴 THE DEFAULTS ARE A CONTRACT: any render WITHOUT the prop must keep the
// exact pre-dock heights (h-[420px] / h-[70vh]) — a caller that never heard
// of the dock must not move. And nothing about the SANDBOX may change here:
// email-html.test.js reads the attribute as code; this file re-asserts it on
// the rendered frame so a height edit that fat-fingers the sandbox fails in
// two places.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import TicketThread from './TicketThread.jsx'

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const TICKET = {
  id: 'T-1',
  status: 'open',
  subject: 'Newsletter',
  requester_email: 'news@sender.ie',
  mailbox: { id: 'mb-1', label: 'Studio', address: 'studio@hatch.ie' },
}

const HTML_MESSAGE = {
  id: 'm1',
  direction: 'inbound',
  from_email: 'news@sender.ie',
  to_emails: ['studio@hatch.ie'],
  text_body: 'plain fallback',
  html_document: '<!doctype html><html><body><p>hello</p></body></html>',
  created_at: '2026-08-31T09:00:00Z',
}

function renderThread(props = {}) {
  return render(
    <TicketThread
      hasSelection
      ticket={TICKET}
      messages={[HTML_MESSAGE]}
      onBack={() => {}}
      onSend={() => {}}
      {...props}
    />
  )
}

const frame = () => document.querySelector('iframe')
const expandButton = () => screen.getByRole('button', { name: /Expand/ })

describe('EmailFrame — context-sized heights', () => {
  it('keeps the pre-dock heights for any render without frameSize', () => {
    renderThread()
    expect(frame().className).toContain('h-[420px]')
    fireEvent.click(expandButton())
    expect(frame().className).toContain('h-[70vh]')
  })

  it('sizes to the dock', () => {
    renderThread({ frameSize: 'dock' })
    expect(frame().className).toContain('h-[38vh]')
    fireEvent.click(expandButton())
    expect(frame().className).toContain('h-[52vh]')
  })

  it('sizes to the takeover', () => {
    renderThread({ frameSize: 'full' })
    expect(frame().className).toContain('h-[65vh]')
    fireEvent.click(expandButton())
    expect(frame().className).toContain('h-[80vh]')
  })

  it('falls back to the defaults for an unknown frameSize', () => {
    renderThread({ frameSize: 'sideways' })
    expect(frame().className).toContain('h-[420px]')
  })

  it('🔴 heights change; the sandbox NEVER does', () => {
    renderThread({ frameSize: 'dock' })
    expect(frame().getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox')
  })
})

describe('EmailFrame — the Expand choice persists', () => {
  it('writes the choice through and opens the NEXT frame expanded', () => {
    renderThread({ frameSize: 'dock' })
    fireEvent.click(expandButton())
    expect(window.localStorage.getItem('un1t.mail.body-expanded')).toBe('1')
    cleanup()
    renderThread({ frameSize: 'dock' })
    expect(frame().className).toContain('h-[52vh]')
  })

  it('collapsing persists too — the memory works in both directions', () => {
    window.localStorage.setItem('un1t.mail.body-expanded', '1')
    renderThread()
    expect(frame().className).toContain('h-[70vh]')
    // /Collapse/ alone also matches the message-fold header; the frame's own
    // toggle is the exact-label one.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(window.localStorage.getItem('un1t.mail.body-expanded')).toBe('0')
    expect(frame().className).toContain('h-[420px]')
  })
})

// ── MAIL-DOCK.1 audit A1 — the attachment preview must be VISIBLE to the
// surface's keyboard guard: the house Modal stops no propagation, so the Esc
// that closes the preview also reaches MailSurface's window listener. The
// guard only holds if this callback reports the overlay's open state.
describe('attachment preview reports itself to the overlay guard', () => {
  it('fires onOverlayOpenChange(true) on open and (false) on close', () => {
    const onOverlayOpenChange = vi.fn()
    renderThread({
      onOverlayOpenChange,
      messages: [{
        ...HTML_MESSAGE,
        attachments: [{ id: 'att-1', filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 1000, stored: true }],
      }],
    })
    fireEvent.click(screen.getAllByRole('button', { name: /invoice\.pdf/ })[0])
    expect(onOverlayOpenChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getAllByRole('button', { name: /^Close$/ })[0])
    expect(onOverlayOpenChange).toHaveBeenLastCalledWith(false)
  })
})
