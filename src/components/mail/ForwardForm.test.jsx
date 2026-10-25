// @vitest-environment jsdom
//
// MAIL-READER.1 — Forward carries NO signature preview.
//
// This file used to pin the opposite (MAILFIX-SIGTRUTH.1: forward was the
// third send path and the only one without a hint, so it grew one). What
// changed is not the send — forward/route.js still appends the sender's
// effective signature for the conversation's studio, under the note and above
// the forwarded block — but where the read-only COPY of it belongs. Three
// composers each reprinting the same unchangeable block is the same text in
// four places, and in a docked reader card it cost more rows than the message
// body got. The preview lives on the account page now, beside the field that
// edits it.
//
// Asserted here as a real absence rather than a missing element: the hint's
// own GET is /api/me/preferences, so a composer that never asks for the
// signature cannot be showing one.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import ForwardForm from './ForwardForm.jsx'

const TICKET = { id: 't-1', subject: 'Membership freeze', location_id: 'loc-still', mailbox: { address: 'hello@stillorgan.ie' } }
const MESSAGE = { id: 'm-1', from_email: 'member@example.com', text_body: 'Please freeze my membership.', attachments: [] }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ForwardForm — no signature preview', () => {
  it('never previews the sign-off the route appends, and never asks for it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<ForwardForm conversation={TICKET} message={MESSAGE} onClose={() => {}} onSent={() => {}} />)
    await act(async () => {})

    expect(screen.queryByText(/added automatically/i)).toBeNull()
    // The one <pre> left is the forwarded message itself, not a signature.
    expect(screen.queryByText(/UN1T|Head Coach|^-- $/)).toBeNull()
    const asked = global.fetch.mock.calls.some(([url]) => String(url).includes('/api/me/preferences'))
    expect(asked).toBe(false)
  })

  it('still forwards: the note field and the quoted message are untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<ForwardForm conversation={TICKET} message={MESSAGE} onClose={() => {}} onSent={() => {}} />)
    await act(async () => {})

    expect(screen.getByLabelText('Add a note').value).toBe('')
    expect(screen.getByText(/Please freeze my membership\./)).toBeTruthy()
  })
})
