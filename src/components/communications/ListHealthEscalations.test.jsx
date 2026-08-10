// @vitest-environment jsdom
//
// LISTHEALTH-ACT.1 — the review cohort could only be dismissed.
//
// That cohort is the one the nightly rule deliberately refuses to act on, so it
// is exactly where an operator's judgement is the product. Dismiss records that
// somebody looked; it does nothing about an address that has now failed across
// four campaigns. The only way to act was SQL against
// contacts.email_suppressed_at, which writes no audit row at all.
//
// Pinned here: the action exists only on review rows, it goes to the route that
// writes the audit trail, Restore still goes where it always did, and neither
// button fires without a click.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import ListHealthEscalations from './ListHealthEscalations.jsx'

const ROW = (over = {}) => ({
  id: 'esc-1',
  name: 'Dead Address',
  email: 'dead@example.com',
  bounced_campaign_count: 4,
  bounce_events: 9,
  bounce_types_label: 'soft, transient',
  successful_deliveries: 2,
  last_bounce_label: '01 Aug 2026',
  since_label: '02 Aug 2026',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: {} }) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const calls = () => global.fetch.mock.calls.map(([url, opts]) => ({ url, method: opts?.method }))

describe('ListHealthEscalations — the review cohort can be acted on', () => {
  it('offers Suppress alongside Dismiss on a review row', () => {
    render(<ListHealthEscalations rows={[ROW()]} mode="review" />)
    expect(screen.getByRole('button', { name: 'Suppress' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('sends Suppress to the route that writes the audit row', async () => {
    render(<ListHealthEscalations rows={[ROW()]} mode="review" />)
    fireEvent.click(screen.getByRole('button', { name: 'Suppress' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(calls()).toEqual([
      { url: '/api/communications/list-health/esc-1/suppress', method: 'POST' },
    ])
  })

  it('Dismiss still goes to the release route', async () => {
    render(<ListHealthEscalations rows={[ROW()]} mode="review" />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(calls()).toEqual([
      { url: '/api/communications/list-health/esc-1/release', method: 'POST' },
    ])
  })

  it('never acts on its own — no request until a button is clicked', () => {
    render(<ListHealthEscalations rows={[ROW(), ROW({ id: 'esc-2' })]} mode="review" />)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('surfaces a refused suppression instead of silently refreshing', async () => {
    global.fetch.mockResolvedValue({ ok: false, json: async () => ({ success: false, error: 'Only a contact awaiting review can be suppressed here.' }) })
    render(<ListHealthEscalations rows={[ROW()]} mode="review" />)
    fireEvent.click(screen.getByRole('button', { name: 'Suppress' }))
    expect(await screen.findByText(/only a contact awaiting review/i)).toBeTruthy()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('locks the other rows while one is in flight', async () => {
    let release
    global.fetch.mockReturnValue(new Promise((r) => { release = r }))
    render(<ListHealthEscalations rows={[ROW(), ROW({ id: 'esc-2' })]} mode="review" />)
    const [first] = screen.getAllByRole('button', { name: 'Suppress' })
    fireEvent.click(first)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Suppress' })[1].disabled).toBe(true))
    release({ ok: true, json: async () => ({ success: true }) })
  })
})

describe('ListHealthEscalations — the suppressed table is unchanged', () => {
  it('offers Restore and nothing else', () => {
    render(<ListHealthEscalations rows={[ROW()]} mode="suppress" />)
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Suppress' })).toBeNull()
  })

  it('Restore still calls the release route, which is also the undo for a manual suppression', async () => {
    render(<ListHealthEscalations rows={[ROW()]} mode="suppress" />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(calls()).toEqual([
      { url: '/api/communications/list-health/esc-1/release', method: 'POST' },
    ])
  })

  it('says so when there is nothing in either table', () => {
    const { rerender } = render(<ListHealthEscalations rows={[]} mode="suppress" />)
    expect(screen.getByText(/no contacts are suppressed for repeat bounces/i)).toBeTruthy()
    rerender(<ListHealthEscalations rows={[]} mode="review" />)
    expect(screen.getByText(/no contacts are waiting to be reviewed/i)).toBeTruthy()
  })
})
