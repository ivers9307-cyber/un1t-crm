// @vitest-environment jsdom
// HOSTPAGE.2 — the host's ratings list on their event page: stars, comment,
// first name, date, and a Hide/Show toggle per rating.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import HostEventRatings from './HostEventRatings.jsx'

const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body })
const LIST = {
  ratings: [
    { id: 'rt1', rating: 5, comment: 'Loved it', is_public: true, created_at: '2026-07-19T09:00:00Z', author: 'Aoife' },
    { id: 'rt2', rating: 2, comment: 'Meh', is_public: false, created_at: '2026-07-19T11:00:00Z', author: '' },
  ],
  summary: { average: 4.7, count: 3, comments: [] },
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HostEventRatings', () => {
  it('lists the ratings with their state and hides one through the PATCH', async () => {
    const fetchMock = vi.fn(async (url, init) => (init?.method === 'PATCH' ? jsonRes({ success: true, data: { id: 'rt1', is_public: false } }) : jsonRes({ success: true, data: LIST })))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventRatings eventId="E1" />)
    expect(await screen.findByText('Loved it')).toBeTruthy()
    expect(screen.getByText('Aoife')).toBeTruthy()
    expect(screen.getByText(/4\.7/)).toBeTruthy()
    expect(screen.getByText('Hidden')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true))
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH')
    expect(String(url)).toBe('/api/host/events/E1/ratings/rt1')
    expect(JSON.parse(init.body)).toEqual({ is_public: false })
    await waitFor(() => expect(screen.getAllByText('Hidden').length).toBe(2))
  })
  it('an event with no ratings says when they are asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ success: true, data: { ratings: [], summary: null } })))
    render(<HostEventRatings eventId="E1" />)
    expect(await screen.findByText(/No ratings yet\. Attendees are asked the morning after the event\./)).toBeTruthy()
  })
})
