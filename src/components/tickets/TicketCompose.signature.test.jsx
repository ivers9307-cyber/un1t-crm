// @vitest-environment jsdom
//
// EMAIL-TICKET.5 follow-up (2026-08-08 audit): the compose route now appends
// the sender's signature exactly as the reply route does, so the composer must
// SHOW it exactly as the reply box does — an operator reading an unsigned
// preview of a signed email would keep typing their name twice. The block is
// the shared <SignatureHint/>, the same component TicketReplyBox renders.
//
// MAILFIX-SIGTRUTH.1 — the hint is now the EFFECTIVE signature for the
// selected From account's studio (the send resolves the studio half off the
// mailbox's own location), so this file also pins the switch: change the
// From account, and the hint re-resolves to that studio's details. With NO
// From account nothing can send, so no hint is mounted.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import TicketCompose from './TicketCompose.jsx'

const MAILBOX = { id: 'mb-1', label: 'Front desk', address: 'hello@example.com', is_default: true, location_id: 'loc-still' }
const noop = () => {}

// Two From accounts at two studios — the multi-studio composer's world.
const STILLORGAN_BOX = {
  id: 'mb-still', label: 'Stillorgan', address: 'hello@stillorgan.ie',
  is_default: true, location_id: 'loc-still',
}
const HATCH_BOX = {
  id: 'mb-hatch', label: 'Hatch Street', address: 'hello@hatch.ie',
  is_default: false, location_id: 'loc-hatch',
}

const RICH = {
  enabled: true, name: 'Alex Example', title: 'Head Coach',
  phone: '087 111 2222', note: '', photo_url: null, links: [],
}

const CONTEXTS = [
  {
    location_id: 'loc-still',
    location_name: 'UN1T Stillorgan',
    studio_signature: { phone: '01 555 0001', links: [] },
    has_mailbox: true,
  },
  { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: true },
]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Returns a promise that settles once the hint has READ the payload, so an
// absence assertion anchors on the fetch having been consumed.
function stubPreferences(data) {
  let markRead
  const read = new Promise((resolve) => { markRead = resolve })
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).includes('/api/me/preferences')) {
      return Promise.resolve({
        json: () => {
          markRead()
          return Promise.resolve({
            success: true,
            data: {
              landing_preference: 'auto',
              email_signature: '',
              email_signature_rich: null,
              active_location_id: null,
              signature_contexts: CONTEXTS,
              ...data,
            },
          })
        },
      })
    }
    return new Promise(() => {})
  }))
  return read
}

describe('TicketCompose — signature preview', () => {
  it('shows the auto-appended sign-off once the viewer’s signature loads', async () => {
    stubPreferences({ email_signature: 'Sarah\nUN1T Stillorgan' })
    render(<TicketCompose mailboxes={[MAILBOX]} onClose={noop} onSent={noop} />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    expect(screen.getByText(/UN1T Stillorgan/)).toBeTruthy()
  })

  it('shows nothing when the viewer has no signature AND the From studio has no card — no stray "--" box', async () => {
    // MAIL-SIGDEFAULT.1 — Hatch has no studio card, so nothing at all appends.
    const read = stubPreferences({ email_signature: '' })
    render(<TicketCompose mailboxes={[{ ...HATCH_BOX, is_default: true }]} onClose={noop} onSent={noop} />)

    // Anchor on the payload having been consumed, then flush React — an
    // absence asserted before the fetch settles would pass vacuously.
    expect(global.fetch).toHaveBeenCalled()
    await read
    await act(async () => {})
    expect(screen.queryByText(/added automatically/i)).toBeNull()
  })

  it('MAIL-SIGDEFAULT.1 — a viewer with NO signature of their own still sees the STUDIO block the From studio adds', async () => {
    stubPreferences({ email_signature: '' })
    render(<TicketCompose mailboxes={[MAILBOX]} onClose={noop} onSent={noop} />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    const pre = document.querySelector('pre')
    expect(pre.textContent).toBe('-- \nUN1T Stillorgan\n01 555 0001')
    expect(pre.textContent).not.toContain('Alex Example')
  })

  it('APPEARS with the rich signature enabled and the plain column empty — the case the old hint hid', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<TicketCompose mailboxes={[STILLORGAN_BOX]} onClose={noop} onSent={noop} />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    const pre = document.querySelector('pre')
    expect(pre.textContent).toContain('Alex Example')
    expect(pre.textContent).toContain('UN1T Stillorgan')
  })

  it('re-resolves when the From account’s studio changes — what the hint shows is what THAT send appends', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<TicketCompose mailboxes={[STILLORGAN_BOX, HATCH_BOX]} onClose={noop} onSent={noop} />)

    // Default From = the default mailbox = Stillorgan: its name, its phone.
    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    let pre = document.querySelector('pre')
    expect(pre.textContent).toContain('UN1T Stillorgan')
    expect(pre.textContent).toContain('01 555 0001')
    expect(pre.textContent).not.toContain('087 111 2222')

    // Switch From to Hatch — no refetch, pure re-resolution: Hatch's name,
    // and the person's own phone since Hatch's card defines none.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'mb-hatch' } })
    pre = document.querySelector('pre')
    expect(pre.textContent).toContain('UN1T Hatch Street')
    expect(pre.textContent).toContain('087 111 2222')
    expect(pre.textContent).not.toContain('01 555 0001')
    expect(pre.textContent).not.toContain('UN1T Stillorgan')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('with NO From account the hint is not mounted — nothing can send, so there is nothing truthful to preview', async () => {
    stubPreferences({ email_signature: 'Plain Sarah', email_signature_rich: RICH })
    render(<TicketCompose mailboxes={[]} onClose={noop} onSent={noop} />)
    // The hint never mounted, so the GET never fired — the strongest form of
    // "not shown".
    await act(async () => {})
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByText(/added automatically/i)).toBeNull()
  })
})
