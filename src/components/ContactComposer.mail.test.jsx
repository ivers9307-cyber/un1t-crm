// @vitest-environment jsdom
//
// PROFILE-MAIL.1 — the contact profile's Email tab rides Mail when it can.
//
// The properties pinned: the From picker lists the caller's VISIBLE accounts
// at the CONTACT'S studio and defaults to the starred (is_default) one; a
// send with an account goes through the Mail compose route (from that
// address, filing a conversation); no usable account — none connected, the
// caller lacks access there, or the lookup failed — falls back to the
// company-sender path byte-for-byte, footer wording included. What the
// footer says at click time is what happens.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import ContactComposer from './ContactComposer.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const MAILBOXES = [
  { id: 'mb-studio', address: 'studio@hatch.ie', label: 'Studio', is_default: false },
  { id: 'mb-accounts', address: 'accounts@hatch.ie', label: 'Accounts', is_default: true },
]

let calls
function stubFetch({ mailboxes = 'none', composeOk = true } = {}) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    if (u.startsWith('/api/email/mail?')) {
      if (mailboxes === 'fail') return { ok: false, status: 403, json: async () => ({ success: false, error: 'no' }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { mailboxes: mailboxes === 'none' ? [] : mailboxes, conversations: [] } }) }
    }
    if (u === '/api/email/tickets/compose') {
      return composeOk
        ? { ok: true, status: 200, json: async () => ({ success: true, data: { ticket_id: 't-9' } }) }
        : { ok: false, status: 500, json: async () => ({ success: false, error: 'send exploded' }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }))
}

function renderComposer(props = {}) {
  return render(
    <ContactComposer
      contactId="c-1"
      contactName="John"
      canEmail
      hasEmail
      contactLocationId="loc-hatch"
      contactEmail="john@example.com"
      defaultChannel="email"
      {...props}
    />
  )
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ContactComposer — Email via Mail', () => {
  it('offers the visible accounts, defaulting to the starred one', async () => {
    stubFetch({ mailboxes: MAILBOXES })
    renderComposer()
    const select = await screen.findByRole('combobox')
    expect(select.value).toBe('mb-accounts') // is_default wins over list order
    expect(screen.queryByText('Sent from the company address')).toBeNull()
  })

  it('sends through the Mail compose route — the DEFAULT account first, then the operator\u2019s choice', async () => {
    stubFetch({ mailboxes: MAILBOXES })
    renderComposer()
    await screen.findByRole('combobox')
    // Untouched picker: the STARRED default goes out — not list position 0
    // (that pairing is what makes an ignored-selection mutant die here).
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Your programme' } })
    fireEvent.change(screen.getByPlaceholderText(/Email John/), { target: { value: 'Hi John, attached below.' } })
    fireEvent.click(screen.getByRole('button', { name: /Send email/ }))
    await waitFor(() => {
      const compose = calls.find(c => c.url === '/api/email/tickets/compose')
      expect(compose?.body).toEqual({
        mailbox_id: 'mb-accounts',
        to: ['john@example.com'],
        subject: 'Your programme',
        text: 'Hi John, attached below.',
      })
    })
    // A changed selection is honoured on the next send.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mb-studio' } })
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Again' } })
    fireEvent.change(screen.getByPlaceholderText(/Email John/), { target: { value: 'Second.' } })
    fireEvent.click(screen.getByRole('button', { name: /Send email/ }))
    await waitFor(() => {
      const sends = calls.filter(c => c.url === '/api/email/tickets/compose')
      expect(sends[1]?.body.mailbox_id).toBe('mb-studio')
    })
    // …and never the company route.
    expect(calls.some(c => c.url === '/api/contacts/c-1/email')).toBe(false)
  })

  it('falls back to the company sender when the studio has no usable account', async () => {
    stubFetch({ mailboxes: 'none' })
    renderComposer()
    await screen.findByText('Sent from the company address')
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Hello' } })
    fireEvent.change(screen.getByPlaceholderText(/Email John/), { target: { value: 'Hi.' } })
    fireEvent.click(screen.getByRole('button', { name: /Send email/ }))
    await waitFor(() => {
      expect(calls.some(c => c.url === '/api/contacts/c-1/email')).toBe(true)
    })
    expect(calls.some(c => c.url === '/api/email/tickets/compose')).toBe(false)
  })

  it('a FAILED account lookup is the company path too — never a dead Email tab', async () => {
    stubFetch({ mailboxes: 'fail' })
    renderComposer()
    await screen.findByText('Sent from the company address')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('a THROWN account lookup (network down) settles on the company path, not an undecided footer', async () => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('/api/email/mail?')) throw new Error('offline')
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    }))
    renderComposer()
    expect(await screen.findByText('Sent from the company address')).toBeTruthy()
  })

  it('a failed Mail send stays on screen with the server’s words — nothing claims sent', async () => {
    stubFetch({ mailboxes: MAILBOXES, composeOk: false })
    renderComposer()
    await screen.findByRole('combobox')
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'x' } })
    fireEvent.change(screen.getByPlaceholderText(/Email John/), { target: { value: 'y' } })
    fireEvent.click(screen.getByRole('button', { name: /Send email/ }))
    expect(await screen.findByText('send exploded')).toBeTruthy()
    expect(screen.getByPlaceholderText(/Email John/).value).toBe('y') // draft kept
  })

  it('without the new props the tab behaves exactly as before (no fetch, company wording)', async () => {
    stubFetch({ mailboxes: MAILBOXES })
    renderComposer({ contactLocationId: null, contactEmail: null })
    await screen.findByText('Sent from the company address')
    expect(calls.filter(c => c.url.startsWith('/api/email/mail?'))).toHaveLength(0)
  })
})
