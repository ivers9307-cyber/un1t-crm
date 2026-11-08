// @vitest-environment jsdom
// HOSTPAGE.2 — the rate page: five stars, an optional comment, one submission;
// a rated link shows what was given; a bad link says so.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import EventRatingPage from './EventRatingPage.jsx'

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body })
const EVENT = { name: 'Mobility', date_label: 'Saturday 18 July 2026', host_name: 'Acme' }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EventRatingPage', () => {
  it('loads the event, submits the chosen stars and comment, then thanks', async () => {
    const fetchMock = vi.fn(async (url, init) => (init?.method === 'POST' ? jsonRes({ success: true, data: { rating: 4, comment: 'Good' } }) : jsonRes({ success: true, data: { event: EVENT, existing: null } })))
    vi.stubGlobal('fetch', fetchMock)
    render(<EventRatingPage token="t0k" />)
    expect(await screen.findByText(/How was Mobility\?/)).toBeTruthy()
    expect(screen.getByText(/Saturday 18 July 2026/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '4 stars' }))
    fireEvent.change(screen.getByLabelText(/Anything to add/), { target: { value: 'Good' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(screen.getByText(/Thanks, you gave 4 stars/)).toBeTruthy())
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(String(url)).toBe('/api/public/event-rating/t0k')
    expect(JSON.parse(init.body)).toEqual({ rating: 4, comment: 'Good' })
  })
  it('a rated link shows what was given and no form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ success: true, data: { event: EVENT, existing: { rating: 5, comment: 'Loved it' } } })))
    render(<EventRatingPage token="t0k" />)
    expect(await screen.findByText(/Thanks, you gave 5 stars/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull()
  })
  it('a bad or expired link says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ success: false, error: 'Not found' }, 404)))
    render(<EventRatingPage token="bad" />)
    expect(await screen.findByText(/This link has expired or isn't valid\./)).toBeTruthy()
  })
  it('Send is disabled until a star is picked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ success: true, data: { event: EVENT, existing: null } })))
    render(<EventRatingPage token="t0k" />)
    await screen.findByText(/How was Mobility\?/)
    expect(screen.getByRole('button', { name: /Send/ }).disabled).toBe(true)
  })
})
