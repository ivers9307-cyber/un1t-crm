// @vitest-environment jsdom
// HOSTSERIES.1 — HostSeriesActions: "Make this a series" posts the name and
// the dates (the weekly helper fills four, a week apart from the event's
// date); an event already in a series shows its page link instead.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }))
const { default: HostSeriesActions } = await import('./HostSeriesActions.jsx')

afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

describe('HostSeriesActions', () => {
  it('posts the name and four weekly dates, then shows the public link', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { series: { id: 'S1', slug: 'mobility' }, created: [{}, {}, {}, {}] } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostSeriesActions eventId="E1" eventName="Mobility" raceDate="2026-11-14" seriesId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Make this a series/ }))
    expect(screen.getByLabelText(/Series name/).value).toBe('Mobility')
    fireEvent.click(screen.getByRole('button', { name: /weekly/i }))
    expect(screen.getAllByLabelText(/^Date \d/)).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /Create series/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/host/events/E1/series')
    expect(JSON.parse(init.body)).toEqual({ name: 'Mobility', dates: ['2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12'] })
    expect(await screen.findByText(/4 dates created/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /series page/i }).getAttribute('href')).toBe('/event/series/mobility')
    expect(refresh).toHaveBeenCalled()
  })
  it('an event already in a series shows the series and its page link', () => {
    render(<HostSeriesActions eventId="E1" eventName="Mobility" raceDate="2026-11-14" seriesId="S1" seriesName="Monthly Mobility" seriesSlug="monthly-mobility" />)
    expect(screen.getByText(/Part of series/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Monthly Mobility/ }).getAttribute('href')).toBe('/event/series/monthly-mobility')
    expect(screen.queryByRole('button', { name: /Make this a series/ })).toBeNull()
  })
  it('a refusal shows the server\'s message inline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ success: false, error: 'already_in_series', message: 'This event is already part of a series.' }) })))
    render(<HostSeriesActions eventId="E1" eventName="Mobility" raceDate="2026-11-14" seriesId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Make this a series/ }))
    fireEvent.click(screen.getByRole('button', { name: /weekly/i }))
    fireEvent.click(screen.getByRole('button', { name: /Create series/ }))
    expect(await screen.findByText(/already part of a series/)).toBeTruthy()
  })
})
