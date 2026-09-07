// @vitest-environment jsdom
//
// MAILFIX-SIGTRUTH.1 — Forward is the THIRD send path (forward/route.js
// appends the sender's effective signature, resolved for the ticket's studio,
// under the note and above the forwarded block) and it had no hint. It now
// renders the same shared <SignatureHint/> as the reply box and the composer,
// handed the ticket's own location — so the three cannot disagree.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import TicketForward from './TicketForward.jsx'

const RICH = {
  enabled: true, name: 'Alex Example', title: 'Head Coach',
  phone: '087 111 2222', note: 'typed note', photo_url: null, links: [],
}

const CONTEXTS = [
  {
    location_id: 'loc-still',
    location_name: 'UN1T Stillorgan',
    studio_signature: { phone: '01 555 0001', links: [] },
    has_mailbox: true,
  },
]

function stubPreferences(data) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).includes('/api/me/preferences')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          data: {
            landing_preference: 'auto',
            email_signature: '',
            email_signature_rich: null,
            active_location_id: null,
            signature_contexts: CONTEXTS,
            ...data,
          },
        }),
      })
    }
    return new Promise(() => {})
  }))
}

const TICKET = { id: 't-1', subject: 'Membership freeze', location_id: 'loc-still', mailbox: { address: 'hello@stillorgan.ie' } }
const MESSAGE = { id: 'm-1', from_email: 'member@example.com', text_body: 'Please freeze my membership.', attachments: [] }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TicketForward — signature hint', () => {
  it('shows the effective signature for the TICKET’S studio beneath the note', async () => {
    stubPreferences({ email_signature: '', email_signature_rich: RICH })
    render(<TicketForward ticket={TICKET} message={MESSAGE} onClose={() => {}} onSent={() => {}} />)

    expect(await screen.findByText(/added automatically/i)).toBeTruthy()
    const pre = screen.getByText(/UN1T Stillorgan/, { selector: 'pre' })
    expect(pre.textContent).toContain('Alex Example')
    expect(pre.textContent).toContain('01 555 0001') // the studio's phone over the person's
    expect(pre.textContent).not.toContain('087 111 2222')
    expect(pre.textContent).not.toContain('typed note')
    // The note field it sits beneath is still there and still empty.
    expect(screen.getByLabelText('Add a note').value).toBe('')
  })
})
