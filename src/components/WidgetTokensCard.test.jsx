// @vitest-environment jsdom
//
// WIDGET.1 — the widget revocation card on the staff detail page.
//
// Covers: one row per live token (label + never-used/last-used line), the
// empty state, an API load error surfacing the API's own message, a
// successful revoke removing its row, and a failed revoke leaving the row
// in place with the error shown. House style follows AdminFeatureMatrix /
// AudienceBuilder's locationlist suite: vi.stubGlobal('fetch', ...) rather
// than a module mock, since this card talks to fetch directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'

import WidgetTokensCard from './WidgetTokensCard.jsx'

const TOKENS = [
  { id: 'tok-1', device_label: "Richard's iPhone", created_at: '2026-08-01T10:00:00Z', last_used_at: '2026-09-05T08:30:00Z' },
  { id: 'tok-2', device_label: null, created_at: '2026-08-15T10:00:00Z', last_used_at: null },
]

let calls
beforeEach(() => {
  calls = []
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET' })
    return handler(String(url), opts)
  }))
}

describe('WidgetTokensCard — loading its list', () => {
  it('renders one row per token, with the label and the never-used / last-used line', async () => {
    stubFetch(async (url) => {
      expect(url).toBe('/api/widget/tokens?profile_id=prof-1')
      return { ok: true, json: async () => ({ success: true, data: { tokens: TOKENS } }) }
    })

    render(<WidgetTokensCard profileId="prof-1" />)

    expect(await screen.findByText("Richard's iPhone")).toBeTruthy()
    expect(screen.getByText('Unnamed device')).toBeTruthy()

    // Row 1 has a real last-used date.
    const row1 = screen.getByText("Richard's iPhone").closest('li')
    expect(within(row1).getByText(/Added .* · last used /)).toBeTruthy()

    // Row 2 (null last_used_at) reads "never used".
    const row2 = screen.getByText('Unnamed device').closest('li')
    expect(within(row2).getByText(/Added .* · never used/)).toBeTruthy()
  })

  it('shows the empty state when the profile has no widgets', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ success: true, data: { tokens: [] } }) }))

    render(<WidgetTokensCard profileId="prof-1" />)

    expect(await screen.findByText('No widgets set up on any device.')).toBeTruthy()
  })

  it("surfaces the API's own error string, not a generic message", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'widget_tokens is unreachable right now' }),
    }))

    render(<WidgetTokensCard profileId="prof-1" />)

    expect(await screen.findByText('widget_tokens is unreachable right now')).toBeTruthy()
    expect(screen.queryByText('No widgets set up on any device.')).toBeNull()
  })
})

describe('WidgetTokensCard — revoking', () => {
  it('clicking Revoke calls DELETE /api/widget/tokens/<id> and removes that row on success', async () => {
    stubFetch(async (url, opts) => {
      if ((opts?.method || 'GET') === 'GET') {
        return { ok: true, json: async () => ({ success: true, data: { tokens: TOKENS } }) }
      }
      expect(url).toBe('/api/widget/tokens/tok-1')
      return { ok: true, json: async () => ({ success: true }) }
    })

    render(<WidgetTokensCard profileId="prof-1" />)
    await screen.findByText("Richard's iPhone")

    const row1 = screen.getByText("Richard's iPhone").closest('li')
    fireEvent.click(within(row1).getByRole('button', { name: /revoke/i }))

    await waitFor(() => expect(screen.queryByText("Richard's iPhone")).toBeNull())
    // The other device's row is untouched.
    expect(screen.getByText('Unnamed device')).toBeTruthy()
    expect(calls.some((c) => c.url === '/api/widget/tokens/tok-1' && c.method === 'DELETE')).toBe(true)
  })

  it('a failed revoke leaves the row in place and shows the error', async () => {
    stubFetch(async (url, opts) => {
      if ((opts?.method || 'GET') === 'GET') {
        return { ok: true, json: async () => ({ success: true, data: { tokens: TOKENS } }) }
      }
      return { ok: false, status: 404, json: async () => ({ success: false, error: 'Not found' }) }
    })

    render(<WidgetTokensCard profileId="prof-1" />)
    await screen.findByText("Richard's iPhone")

    const row1 = screen.getByText("Richard's iPhone").closest('li')
    fireEvent.click(within(row1).getByRole('button', { name: /revoke/i }))

    await waitFor(() => expect(within(row1).getByText('Not found')).toBeTruthy())
    // Row is still there — a failed revoke must not remove it.
    expect(screen.getByText("Richard's iPhone")).toBeTruthy()
  })

  it('disables the row button and reads Revoking… while the request is in flight', async () => {
    let resolveDelete
    stubFetch(async (url, opts) => {
      if ((opts?.method || 'GET') === 'GET') {
        return { ok: true, json: async () => ({ success: true, data: { tokens: TOKENS } }) }
      }
      return new Promise((resolve) => { resolveDelete = resolve })
    })

    render(<WidgetTokensCard profileId="prof-1" />)
    await screen.findByText("Richard's iPhone")

    const row1 = screen.getByText("Richard's iPhone").closest('li')
    const button = within(row1).getByRole('button', { name: /revoke/i })
    fireEvent.click(button)

    await waitFor(() => expect(within(row1).getByRole('button', { name: /revoking/i }).disabled).toBe(true))

    resolveDelete({ ok: true, json: async () => ({ success: true }) })
    await waitFor(() => expect(screen.queryByText("Richard's iPhone")).toBeNull())
  })
})
