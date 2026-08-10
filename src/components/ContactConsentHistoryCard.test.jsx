// @vitest-environment jsdom
//
// CONSENT-COPY.1 — the consent history card had no test at all, which is a
// strange thing to say about the surface a subject-access request is answered
// from. What is pinned here is what a compliance answer depends on:
//
//   1. the CSV export is reachable WITHOUT expanding the card, points at the
//      same gated route, and asks the browser to download rather than navigate;
//   2. an opt-out is never rendered as anything other than a withdrawal, and a
//      source is never shown as a raw slug when we know its name;
//   3. "performed by" distinguishes the customer acting for themselves from
//      staff acting on their behalf, because those are different legal facts;
//   4. the row cap tells the operator how to get the rest, and since the export
//      shipped that is the export, not a SQL prompt aimed at someone who has no
//      database access.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import ContactConsentHistoryCard from './ContactConsentHistoryCard.jsx'

const CONTACT = 'c0ntact-1'

const ROW = (over = {}) => ({
  id: 'r1',
  created_at: '2026-08-01T10:30:00.000Z',
  channel: 'email_marketing',
  action: 'opt_out',
  source: 'preference_centre',
  location_name: 'Stillorgan',
  performed_by_name: null,
  ...over,
})

let payload
beforeEach(() => {
  payload = { success: true, rows: [ROW()], truncated: false }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const expand = () => fireEvent.click(screen.getByText(/consent history/i))

describe('ContactConsentHistoryCard — the export is the SAR answer', () => {
  it('offers the CSV export without expanding the card first', () => {
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    const link = screen.getByText(/export csv/i).closest('a')
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe(`/api/contacts/${CONTACT}/consent-log?format=csv`)
    expect(link.hasAttribute('download')).toBe(true)
  })

  it('does not load the feed until the card is opened', () => {
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('loads the feed once, from the same gated route', async () => {
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    await screen.findByText('Stillorgan')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe(`/api/contacts/${CONTACT}/consent-log`)
    // Collapse and re-open: the rows are already in memory.
    fireEvent.click(screen.getByText(/consent history/i))
    expand()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('ContactConsentHistoryCard — the row cap points at the export', () => {
  it('tells the operator to use the export, not to query the database', async () => {
    payload = { success: true, rows: [ROW()], truncated: true }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    const note = await screen.findByText(/showing the most recent 500 events/i)
    expect(note.textContent).toMatch(/export csv/i)
    expect(note.textContent.toLowerCase()).not.toContain('consent_log')
    expect(note.textContent.toLowerCase()).not.toContain('query')
    expect(note.textContent).not.toContain('—')
  })

  it('says nothing about a cap when the history fits', async () => {
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    await screen.findByText('Stillorgan')
    expect(screen.queryByText(/showing the most recent/i)).toBeNull()
  })

  it('marks the count as a floor when the feed was capped', async () => {
    payload = { success: true, rows: [ROW(), ROW({ id: 'r2' })], truncated: true }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    expect(await screen.findByText('2+ events')).toBeTruthy()
  })
})

describe('ContactConsentHistoryCard — a consent row reads as what it is', () => {
  it('renders an opt-out as a withdrawal and an opt-in as a grant', async () => {
    payload = {
      success: true,
      rows: [ROW(), ROW({ id: 'r2', action: 'opt_in', channel: 'sms_marketing' })],
      truncated: false,
    }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    expect(await screen.findByText('Opt-out')).toBeTruthy()
    expect(screen.getByText('Opt-in')).toBeTruthy()
    expect(screen.getByText('Email · marketing')).toBeTruthy()
    expect(screen.getByText('SMS · marketing')).toBeTruthy()
  })

  it('names a known source instead of showing its slug', async () => {
    payload = { success: true, rows: [ROW({ source: 'leadcap1_scope_correction' })], truncated: false }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    expect(await screen.findByText('Scope correction (admin)')).toBeTruthy()
    expect(screen.queryByText('leadcap1_scope_correction')).toBeNull()
  })

  it('falls back to the raw source rather than hiding an unknown one', async () => {
    payload = { success: true, rows: [ROW({ source: 'some_new_source' })], truncated: false }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    expect(await screen.findByText('some_new_source')).toBeTruthy()
  })

  it('distinguishes the customer acting for themselves from staff acting for them', async () => {
    payload = {
      success: true,
      rows: [
        ROW({ id: 'r1', source: 'preference_centre' }),
        ROW({ id: 'r2', source: 'admin_panel', performed_by_name: 'Dana Coach' }),
        ROW({ id: 'r3', source: 'postmark_hard_bounce' }),
      ],
      truncated: false,
    }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    expect(await screen.findByText('customer')).toBeTruthy()
    expect(screen.getByText('Dana Coach')).toBeTruthy()
    expect(screen.getByText('system')).toBeTruthy()
  })
})

describe('ContactConsentHistoryCard — failure is visible, never an empty history', () => {
  it('shows the server error instead of "no consent events"', async () => {
    payload = { success: false, error: 'consent_log lookup failed' }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    expect(await screen.findByText('consent_log lookup failed')).toBeTruthy()
    expect(screen.queryByText(/no consent events on file/i)).toBeNull()
  })

  it('retries on the next open rather than caching a failure as an empty list', async () => {
    payload = { success: false, error: 'boom' }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    await screen.findByText('boom')
    fireEvent.click(screen.getByText(/consent history/i))
    payload = { success: true, rows: [ROW()], truncated: false }
    expand()
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Stillorgan')).toBeTruthy()
  })

  it('says so plainly when there genuinely is nothing on file', async () => {
    payload = { success: true, rows: [], truncated: false }
    render(<ContactConsentHistoryCard contactId={CONTACT} />)
    expand()
    expect(await screen.findByText(/no consent events on file/i)).toBeTruthy()
  })
})
