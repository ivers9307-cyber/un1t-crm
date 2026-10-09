// @vitest-environment jsdom
//
// EVENT-WAITLIST.1 — the staff/host waitlist panel: list with the count,
// Remove (staff only), Offer now (confirm, then the round's result).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import EventWaitlistPanel, { offerResultMessage } from './EventWaitlistPanel.jsx'

const ROWS = [
  { id: 'a', name: 'Ann Example', email: 'ann@example.test', phone: '0870000000', headcount: 2, status: 'waiting', created_at: '2026-10-09T10:00:00Z', last_offered_at: null, offer_count: 0 },
  { id: 'b', name: 'Bo Example', email: 'bo@example.test', phone: null, headcount: 1, status: 'offered', created_at: '2026-10-09T11:00:00Z', last_offered_at: '2026-10-09T12:00:00Z', offer_count: 2 },
  { id: 'c', name: 'Cy Example', email: 'cy@example.test', phone: null, headcount: 1, status: 'removed', removed_by_name: 'Sam Staff', created_at: '2026-10-08T11:00:00Z' },
]
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async (url, init) => {
    if (init?.method === 'POST') return jsonRes({ success: true, data: { events: 1, offered: 2, expired: 0, skipped: 0, failed: 0, no_room: 0 } })
    if (init?.method === 'DELETE') return jsonRes({ success: true, data: { id: 'a', status: 'removed' } })
    return jsonRes({ success: true, data: { rows: ROWS, waiting: 2 } })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('confirm', vi.fn(() => true))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const staff = () => render(<EventWaitlistPanel listUrl="/api/events/e1/waitlist" offerUrl="/api/events/e1/waitlist/offer" removeUrlFor={(id) => `/api/events/e1/waitlist/${id}`} />)

describe('EventWaitlistPanel', () => {
  it('lists every row with the count still waiting', async () => {
    staff()
    expect(await screen.findByRole('heading', { name: 'Waitlist (2 waiting)' })).toBeTruthy()
    expect(screen.getByText('Ann Example')).toBeTruthy()
    expect(screen.getByText('ann@example.test')).toBeTruthy()
    expect(screen.getByText('Removed by Sam Staff')).toBeTruthy()
    // Remove only on rows still on the list.
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
  })

  it('Remove asks, then deletes that row and reloads', async () => {
    staff()
    await screen.findByText('Ann Example')
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/events/e1/waitlist/a', { method: 'DELETE' }))
    expect(confirm).toHaveBeenCalledWith('Take Ann Example off the waitlist?')
  })

  it('Offer now asks, runs the round, says what happened', async () => {
    staff()
    fireEvent.click(await screen.findByRole('button', { name: 'Offer now' }))
    await screen.findByText('Offered to 2 people.')
    expect(fetchMock).toHaveBeenCalledWith('/api/events/e1/waitlist/offer', { method: 'POST' })
  })

  it('a cancelled confirm does nothing', async () => {
    confirm.mockReturnValue(false)
    staff()
    fireEvent.click(await screen.findByRole('button', { name: 'Offer now' }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('read-only (hosts): no Remove', async () => {
    render(<EventWaitlistPanel dark listUrl="/api/host/events/e1/waitlist" offerUrl="/api/host/events/e1/waitlist/offer" />)
    await screen.findByText('Ann Example')
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Offer now' })).toBeTruthy()
  })

  it('nobody waiting: no Offer now, a plain empty line', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ success: true, data: { rows: [], waiting: 0 } }))
    staff()
    await screen.findByText(/Nobody is waiting/)
    expect(screen.queryByRole('button', { name: 'Offer now' })).toBeNull()
  })

  it('a failed load shows the error', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ success: false, error: 'load_failed', message: 'The waitlist could not be read. Try again.' }, 500))
    staff()
    expect((await screen.findByRole('alert')).textContent).toMatch('The waitlist could not be read')
  })
})

describe('offerResultMessage', () => {
  it('reads the round counts', () => {
    expect(offerResultMessage({ no_room: 1 })).toBe('Every time is still full, so nobody was offered.')
    expect(offerResultMessage({ offered: 1, skipped: 0, failed: 0, no_room: 0 })).toBe('Offered to 1 person.')
    expect(offerResultMessage({ offered: 0, skipped: 3, failed: 0, no_room: 0 })).toBe('Nobody was due an offer. 3 skipped (offered in the last 24 hours, or opted out).')
    expect(offerResultMessage({ offered: 2, skipped: 0, failed: 1, no_room: 0 })).toBe('Offered to 2 people. 1 could not be sent and will be retried.')
  })
})
