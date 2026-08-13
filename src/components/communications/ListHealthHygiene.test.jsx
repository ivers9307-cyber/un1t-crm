// @vitest-environment jsdom
//
// HYGREL.1 — the roster behind the Suppressed number.
//
// Two things here are not cosmetic. A bounce-owned row must NOT offer a Release
// button: that stamp belongs to an email_bounce_escalations row (mig 515) that
// has to close with the release, the endpoint refuses it, and an operator who
// clicks a button that always errors stops trusting the page. And the list has
// to page — the population outgrew the 1,000-row select cap the night the
// founding cohort crossed the 90-day guard together, so "Load more" is the
// difference between the list being true and the list being 1,000 of 1,128.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

import ListHealthHygiene from './ListHealthHygiene.jsx'

const ROW = (over = {}) => ({
  contact_id: 'c1',
  name: 'Quiet Member',
  email: 'quiet@example.com',
  email_status: 'active',
  pipeline_stage_slug: 'member',
  suppressed_at: '2026-08-12T05:15:00.000Z',
  previously_released_at: null,
  has_bounce_escalation: false,
  ...over,
})

function mockApi(pages) {
  let call = 0
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (opts?.method === 'POST') return { ok: true, json: async () => ({ success: true, data: {} }) }
    const page = pages[Math.min(call++, pages.length - 1)]
    return { ok: true, json: async () => ({ success: true, data: page }) }
  }))
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ListHealthHygiene', () => {
  it('names the people behind the count and says which sweep holds each one', async () => {
    mockApi([{ rows: [ROW(), ROW({ contact_id: 'c2', name: 'Bouncer', has_bounce_escalation: true })], total: 2, offset: 0, limit: 100 }])
    render(<ListHealthHygiene />)

    expect(await screen.findByText('Quiet Member')).toBeTruthy()
    expect(screen.getByText('No opens or clicks')).toBeTruthy()
    expect(screen.getByText('Repeat bounces')).toBeTruthy()
  })

  it('offers Release only where this route can actually grant it', async () => {
    mockApi([{ rows: [ROW(), ROW({ contact_id: 'c2', name: 'Bouncer', has_bounce_escalation: true })], total: 2, offset: 0, limit: 100 }])
    render(<ListHealthHygiene />)

    await screen.findByText('Quiet Member')
    expect(screen.getAllByRole('button', { name: 'Release' })).toHaveLength(1)
    expect(screen.getByText(/restore from the repeat-bounce table/i)).toBeTruthy()
  })

  it('releases through the contact-keyed endpoint and drops the row', async () => {
    mockApi([{ rows: [ROW()], total: 1, offset: 0, limit: 100 }])
    render(<ListHealthHygiene />)

    fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
    await waitFor(() => expect(screen.queryByText('Quiet Member')).toBeNull())
    expect(global.fetch.mock.calls.some(([url, opts]) =>
      url === '/api/communications/hygiene-suppressions/c1/release' && opts?.method === 'POST')).toBe(true)
  })

  it('pages the tail rather than stopping at the first select', async () => {
    mockApi([
      { rows: [ROW()], total: 1128, offset: 0, limit: 100 },
      { rows: [ROW({ contact_id: 'c-1001', name: 'Row One Thousand And One' })], total: 1128, offset: 1, limit: 100 },
    ])
    render(<ListHealthHygiene />)

    expect(await screen.findByText(/showing 1 of 1,128/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('Row One Thousand And One')).toBeTruthy()
    // The second request asks for the next offset, not page one again.
    expect(global.fetch.mock.calls[1][0]).toContain('offset=1')
  })

  it('surfaces a refused release instead of silently dropping the row', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') {
        return { ok: false, json: async () => ({ success: false, error: 'This contact is suppressed for repeat bounces.' }) }
      }
      return { ok: true, json: async () => ({ success: true, data: { rows: [ROW()], total: 1, offset: 0, limit: 100 } }) }
    }))
    render(<ListHealthHygiene />)

    fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
    expect(await screen.findByText(/suppressed for repeat bounces/i)).toBeTruthy()
    expect(screen.getByText('Quiet Member')).toBeTruthy()
  })

  it('never acts on its own — no release fires without a click', async () => {
    mockApi([{ rows: [ROW(), ROW({ contact_id: 'c2', name: 'Second Member' })], total: 2, offset: 0, limit: 100 }])
    render(<ListHealthHygiene />)
    await screen.findByText('Second Member')
    expect(global.fetch.mock.calls.every(([, opts]) => opts?.method !== 'POST')).toBe(true)
  })
})
