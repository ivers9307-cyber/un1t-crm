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
  it('POSTs with the ?l= location scope when the page carried one', () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" />)

    fireEvent.click(screen.getByRole('button', { name: /^Unsubscribe from/ }))

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/api/unsubscribe/tok-1?l=loc-1')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body).channels).toEqual(
      expect.arrayContaining(['email_marketing', 'whatsapp_marketing', 'sms_marketing'])
    )
  })

  it('POSTs unscoped (global opt-out) when no location is present — back-compat for old links', () => {
    render(<UnsubscribePage token="tok-1" />)

    fireEvent.click(screen.getByRole('button', { name: /^Unsubscribe from/ }))

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-1')
  })

  it('URI-encodes the location id in the POST URL', () => {
    render(<UnsubscribePage token="tok-1" locationId="a b&c" />)

    fireEvent.click(screen.getByRole('button', { name: /^Unsubscribe from/ }))

    expect(fetch.mock.calls[0][0]).toBe(`/api/unsubscribe/tok-1?l=${encodeURIComponent('a b&c')}`)
  })
})
