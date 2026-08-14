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
import { StrictMode } from 'react'
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

  it('URL-encodes the location id in the POST URL', async () => {
    render(<UnsubscribePage token="tok-1" locationId="a b&c" />)

    await screen.findByText(/You've been unsubscribed/i)

    // UNSUBAUTO.4 — the query is built with URLSearchParams now (so the
    // l-absent / c-present case cannot produce a malformed URL), which spells
    // a space `+` rather than %20. Both decode identically through the route's
    // `new URL(request.url).searchParams.get('l')`. What this test guards is
    // unchanged: `&` is escaped and cannot inject a second parameter.
    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-1?l=a+b%26c')
  })
})

// UNSUBAUTO.4 — `?c=` names the campaign whose email carried the link, and the
// API route reads it to attribute the opt-out (increment_campaign_metric →
// campaigns.total_unsubscribed). The server page threaded only `l`, and
// submitOptOut built only `?l=`, so every page-path opt-out was invisible to
// that counter. UNSUBAUTO.1 multiplies page-path opt-outs several-fold, so the
// undercount is now much larger than it was.
describe('UnsubscribePage — campaign attribution (UNSUBAUTO.4)', () => {
  it('carries BOTH ?l= and &c= when the link had both', async () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" campaignId="camp-1" />)

    await screen.findByText(/You've been unsubscribed/i)

    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-1?l=loc-1&c=camp-1')
  })

  it('carries ?c= alone when there is no location — no stray ?l=', async () => {
    render(<UnsubscribePage token="tok-1" locationId={null} campaignId="camp-1" />)

    await screen.findByText(/You've been unsubscribed/i)

    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-1?c=camp-1')
  })

  it('carries neither when the link had neither', async () => {
    render(<UnsubscribePage token="tok-1" />)

    await screen.findByText(/You've been unsubscribed/i)

    expect(fetch.mock.calls[0][0]).toBe('/api/unsubscribe/tok-1')
  })
})

describe('UnsubscribePage — auto-submit on arrival (UNSUBAUTO.1)', () => {
  it('POSTs the opt-out on mount without any click', async () => {
    render(<UnsubscribePage token="tok-1" locationId="loc-1" />)
    await screen.findByText(/You've been unsubscribed/i)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/api/unsubscribe/tok-1?l=loc-1')
    // The route only writes on POST; a GET there redirects to the preference
    // centre and records nothing. Asserting the verb is the difference between
    // "the page called the API" and "the page opted the person out".
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ channels: ['email_marketing'] })
  })

  it('POSTs exactly once under a real StrictMode double-mount', async () => {
    // UNSUBAUTO.3 — this used to `rerender`, which never re-invokes a
    // []-dependency effect, so it passed identically with the `autoSubmitted`
    // ref guard deleted and proved nothing. A real <StrictMode> render is what
    // double-invokes the effect, which is the thing the guard exists for.
    render(<StrictMode><UnsubscribePage token="tok-1" locationId={null} /></StrictMode>)
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

  // UNSUBAUTO.3 — "Processing…" is a dead end: no controls, no escape. Without
  // a timeout a flaky mobile connection can hold the browser there for
  // minutes, and a visitor who gives up and closes the tab is unrecorded —
  // a narrow re-entry of the exact harm the auto-submit removes.
  it('carries an abort signal so the auto-submit cannot hang forever', async () => {
    render(<UnsubscribePage token="tok-1" locationId={null} />)
    await screen.findByText(/You've been unsubscribed/i)
    const [, opts] = fetch.mock.calls[0]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('drops to the manual button when the auto-submit times out', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'AbortError'))
    ))
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
    // UNSUBAUTO.3 — the confirmation names the channel. After the failure →
    // manual → retry path the visitor may have opted out of all three, but
    // Resubscribe restores email_marketing only; "back on the list" overclaimed.
    await screen.findByText(/You're back on the marketing email list/i)
    const put = fetch.mock.calls.find(([, o]) => o?.method === 'PUT')
    expect(put[0]).toBe('/api/preferences/tok-1')
    expect(JSON.parse(put[1].body)).toEqual({ locationId: 'loc-1', email_marketing: true })
  })

  it('OMITS locationId entirely on a location-less link — a null 400s the schema', async () => {
    // UNSUBAUTO.3 — PreferencesUpdateSchema has `locationId: z.string().optional()`,
    // and zod 4 accepts `undefined` but REJECTS `null` (verified directly against
    // zod 4.4.3). The server page passes `searchParams?.l || null`, so sending the
    // key unconditionally put `null` on the wire and validateBody 400'd — Resubscribe
    // could never work on any pre-LOCCOMMS.4 email or any campaign without a
    // location. The fix is the omit idiom PreferenceCentre.jsx already uses; the
    // server schema is correct and must NOT be loosened to .nullable().
    render(<UnsubscribePage token="tok-1" locationId={null} />)
    await screen.findByText(/You've been unsubscribed/i)
    fireEvent.click(screen.getByRole('button', { name: /Resubscribe/i }))
    await screen.findByText(/You're back on the marketing email list/i)

    const put = fetch.mock.calls.find(([, o]) => o?.method === 'PUT')
    const body = JSON.parse(put[1].body)
    // The KEY must be absent, not merely falsy — `{ locationId: null }` is the bug.
    expect('locationId' in body).toBe(false)
    expect(body).toEqual({ email_marketing: true })
  })
})
