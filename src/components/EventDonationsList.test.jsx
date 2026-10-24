// @vitest-environment jsdom
//
// CHARITY.10 — the staff donations list: totals tiles, the table, the CSV link,
// and "Mark as refunded" only on paid rows (and only for managers).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import EventDonationsList from './EventDonationsList.jsx'

const PAYLOAD = {
  success: true,
  data: {
    currency: 'EUR',
    settings: { name: 'MS Ireland', match_multiplier: 2, include_entries: false },
    totals: { donations_cents: 2500, donations_matched_cents: 5000, entries_cents: 0, entries_matched_cents: 0, raised_cents: 5000, donation_count: 1 },
    donations: [
      { id: 'd1', paid_at: '2026-07-01T11:30:00Z', paid_at_label: '1 Jul 2026, 12:30', donor_name: 'Ava Byrne', donor_email: 'ava@example.com', amount_cents: 2500, match_multiplier: 2, matched_cents: 5000, currency: 'EUR', status: 'paid', message: 'Go team', receipt_email_status: 'sent', refunded_at: null },
      { id: 'd2', paid_at: null, paid_at_label: null, donor_name: 'Ben Doyle', donor_email: 'ben@example.com', amount_cents: 1000, match_multiplier: null, matched_cents: 0, currency: 'EUR', status: 'awaiting_payment', message: null, receipt_email_status: null, refunded_at: null },
      { id: 'd3', paid_at: '2026-07-01T10:00:00Z', paid_at_label: '1 Jul 2026, 11:00', donor_name: 'Cara Lee', donor_email: 'cara@example.com', amount_cents: 1500, match_multiplier: 2, matched_cents: 0, currency: 'EUR', status: 'refunded', message: null, receipt_email_status: 'sent', refunded_at: '2026-07-02T09:00:00Z' },
    ],
  },
}

function stubFetch(handler) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn((url, opts) => {
    calls.push({ url: String(url), opts })
    return Promise.resolve(handler(String(url), opts))
  }))
  return calls
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('EventDonationsList', () => {
  it('fetches the list, renders the totals and rows, and links the CSV export', async () => {
    const calls = stubFetch(() => json(PAYLOAD))
    const { container } = render(<EventDonationsList raceId="ev-1" canMarkRefunded />)
    await waitFor(() => expect(screen.getByText('Ava Byrne')).toBeTruthy())
    expect(calls[0].url).toBe('/api/events/ev-1/donations')
    expect(container.textContent).toContain('€25.00')
    expect(container.textContent).toContain('€50.00')
    expect(container.textContent).toContain('1 Jul 2026, 12:30')
    const csv = screen.getByText('Export CSV').closest('a')
    expect(csv.getAttribute('href')).toBe('/api/events/ev-1/donations?format=csv')
  })

  it('shows "Mark as refunded" only on paid rows', async () => {
    stubFetch(() => json(PAYLOAD))
    render(<EventDonationsList raceId="ev-1" canMarkRefunded />)
    await waitFor(() => expect(screen.getByText('Ava Byrne')).toBeTruthy())
    expect(screen.getAllByText('Mark as refunded')).toHaveLength(1)
  })

  it('hides the button from a caller who cannot mark refunds', async () => {
    stubFetch(() => json(PAYLOAD))
    render(<EventDonationsList raceId="ev-1" canMarkRefunded={false} />)
    await waitFor(() => expect(screen.getByText('Ava Byrne')).toBeTruthy())
    expect(screen.queryByText('Mark as refunded')).toBeNull()
  })

  it('confirms, POSTs the refund and reloads the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const calls = stubFetch((url, opts) => (opts?.method === 'POST' ? json({ success: true, data: { changed: true } }) : json(PAYLOAD)))
    render(<EventDonationsList raceId="ev-1" canMarkRefunded />)
    await waitFor(() => expect(screen.getByText('Ava Byrne')).toBeTruthy())
    fireEvent.click(screen.getByText('Mark as refunded'))
    await waitFor(() => expect(calls.filter((c) => c.opts?.method === 'POST')).toHaveLength(1))
    expect(calls.find((c) => c.opts?.method === 'POST').url).toBe('/api/events/ev-1/donations/d1/refunded')
    await waitFor(() => expect(calls.filter((c) => !c.opts?.method)).toHaveLength(2))
  })

  it('does nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const calls = stubFetch(() => json(PAYLOAD))
    render(<EventDonationsList raceId="ev-1" canMarkRefunded />)
    await waitFor(() => expect(screen.getByText('Ava Byrne')).toBeTruthy())
    fireEvent.click(screen.getByText('Mark as refunded'))
    expect(calls.filter((c) => c.opts?.method === 'POST')).toHaveLength(0)
  })
})
