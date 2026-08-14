// @vitest-environment jsdom
//
// COMMSFIX.A.2 — the page unsubscribe must honour the ?l= location scope.
//
// buildUnsubscribeUrl (postmark.js) deliberately appends ?l=<locationId>
// (LOCCOMMS.4) so leaving one studio's list does not remove the person
// everywhere — but the page never read it and POSTed unscoped, so EVERY
// footer-link unsubscribe was a global, all-channel opt-out (live
// consent_log: all 36 page opt-outs in 30 days were unscoped triplets).
// The API route resolves the scope from the POST URL's ?l= query
// (src/app/api/unsubscribe/[token]/route.js: scopeLocationId), so the
// component must forward it there. No l → unchanged global behaviour
// (back-compat for already-delivered location-less links).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import UnsubscribePage from './UnsubscribePage.jsx'

// NOTE: the server page (src/app/unsubscribe/[token]/page.js) threads
// searchParams.l into <UnsubscribePage locationId=…>. It is not imported
// here because vitest/rolldown cannot parse JSX in .js app-router files
// (no page.js is imported by any test in this repo — only route.js).

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ json: async () => ({ success: true, unsubscribed_channels: ['email_marketing'] }) })
  ))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UnsubscribePage — location-scoped POST (COMMSFIX.A.2)', () => {
  // UNSUBAUTO.1 — these three used to fireEvent.click the manual button to
  // trigger the POST. The opt-out now fires on mount (see below), so the
  // click-driven POST no longer exists to assert on — the render itself is
  // the trigger, and fetch.mock.calls[0] is that auto-fired request. The
  // scope-forwarding behaviour these guard (COMMSFIX.A.2 / LOCCOMMS.4) is
  // unchanged; only how the POST gets triggered changed.
  it('POSTs with the ?l= location scope when the page carried one', async () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" />)

    await screen.findByText(/You've been unsubscribed/i)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-1?l=loc-1')
  })

  it('POSTs unscoped (global opt-out) when no location is present — back-compat for old links', async () => {
    render(<UnsubscribePage token="tok-1" />)

    await screen.findByText(/You've been unsubscribed/i)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-1')
  })

  it('URI-encodes the location id in the POST URL', async () => {
    render(<UnsubscribePage token="tok-1" locationId="a b&c" />)

    await screen.findByText(/You've been unsubscribed/i)

    expect(fetch.mock.calls[0][0]).toBe(`/api/unsubscribe/tok-1?l=${encodeURIComponent('a b&c')}`)
  })
})

describe('UnsubscribePage — auto-submit on arrival (UNSUBAUTO.1)', () => {
  it('POSTs the opt-out on mount without any click', async () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" />)
    await screen.findByText(/You've been unsubscribed/i)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/api/unsubscribe/tok-1?l=loc-1')
    expect(JSON.parse(opts.body)).toEqual({ channels: ['email_marketing'] })
  })

  it('POSTs exactly once even if the effect is invoked twice (StrictMode)', async () => {
    const { rerender } = render(<UnsubscribePage token="tok-1" locationId={null} />)
    rerender(<UnsubscribePage token="tok-1" locationId={null} />)
    await screen.findByText(/You've been unsubscribed/i)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to the manual button and does NOT claim success when the POST fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ json: async () => ({ success: false, error: 'Invalid token' }) })
    ))
    render(<UnsubscribePage token="bad" locationId={null} />)
    expect(await screen.findByRole('button', { name: /Unsubscribe from/i })).toBeTruthy()
    expect(screen.queryByText(/You've been unsubscribed/i)).toBeNull()
  })

  it('falls back to the manual button when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    render(<UnsubscribePage token="tok-1" locationId={null} />)
    expect(await screen.findByRole('button', { name: /Unsubscribe from/i })).toBeTruthy()
    expect(screen.queryByText(/You've been unsubscribed/i)).toBeNull()
  })

  it('falls back to the manual button on failure, then POSTs all selected channels on retry', async () => {
    // First call (the auto-submit) fails; every call after succeeds — this
    // exercises the failure → manual fallback → retry journey end to end,
    // and restores the assertion COMMSFIX.A.2's click-driven rewrite dropped:
    // that the manual multi-channel button still POSTs every ticked channel.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ success: false, error: 'Invalid token' }) })
      .mockResolvedValue({ json: async () => ({
        success: true,
        unsubscribed_channels: ['email_marketing', 'whatsapp_marketing', 'sms_marketing'],
      }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<UnsubscribePage token="tok-1" locationId={null} />)

    const button = await screen.findByRole('button', { name: /Unsubscribe from/i })
    fireEvent.click(button)

    await screen.findByText(/You've been unsubscribed/i)

    expect(fetch).toHaveBeenCalledTimes(2)
    const [, opts] = fetch.mock.calls[1]
    expect(JSON.parse(opts.body).channels).toEqual(
      expect.arrayContaining(['email_marketing', 'whatsapp_marketing', 'sms_marketing'])
    )
  })
})

describe('UnsubscribePage — undo (UNSUBAUTO.2)', () => {
  it('offers Resubscribe and PUTs the opt-in when pressed', async () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" />)
    await screen.findByText(/You've been unsubscribed/i)
    fireEvent.click(screen.getByRole('button', { name: /Resubscribe/i }))
    await screen.findByText(/You're back on the list/i)
    const put = fetch.mock.calls.find(([, o]) => o?.method === 'PUT')
    expect(put[0]).toBe('/api/preferences/tok-1')
    expect(JSON.parse(put[1].body)).toEqual({ locationId: 'loc-1', email_marketing: true })
  })
})
