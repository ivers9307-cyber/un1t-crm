// @vitest-environment jsdom
//
// EMAIL-TICKET.5 follow-up (2026-08-08 audit): the compose route now appends
// the sender's signature exactly as the reply route does, so the composer must
// SHOW it exactly as the reply box does — an operator reading an unsigned
// preview of a signed email would keep typing their name twice. The block is
// the shared <SignatureHint/>, the same component TicketReplyBox renders.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import TicketCompose from './TicketCompose.jsx'

const MAILBOX = { id: 'mb-1', label: 'Front desk', address: 'hello@example.com', is_default: true }
const noop = () => {}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubPreferences(signature) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).includes('/api/me/preferences')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { email_signature: signature } }) })
    }
    return new Promise(() => {})
  }))
}

describe('TicketCompose — signature preview', () => {
  it('shows the auto-appended sign-off once the viewer’s signature loads', async () => {
    stubPreferences('Sarah\nUN1T Stillorgan')
    render(<TicketCompose mailboxes={[MAILBOX]} onClose={noop} onSent={noop} />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    expect(screen.getByText(/UN1T Stillorgan/)).toBeTruthy()
  })

  it('shows nothing when the viewer has no signature — no stray "--" box', async () => {
    stubPreferences('')
    render(<TicketCompose mailboxes={[MAILBOX]} onClose={noop} onSent={noop} />)

    // Let the preferences fetch settle before asserting absence.
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText(/added automatically/i)).toBeNull()
  })
})
