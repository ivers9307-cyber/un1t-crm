// @vitest-environment jsdom
// HOSTSERIES.1 — DuplicateEventButton: a date (default a week after the
// source) and a Duplicate button; posts to apiUrl and opens the copy's edit page.
// HOTFIX 9 Nov 2026: the destination is a URL TEMPLATE string (`{id}`), never a
// function — the button is rendered by Server Components, and a function prop
// cannot cross that boundary (it crashed /host/events/[id]).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
const { default: DuplicateEventButton } = await import('./DuplicateEventButton.jsx')

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear() })

describe('DuplicateEventButton', () => {
  it('defaults the date to a week after the source, posts it, and opens the copy', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E-new', slug: 's' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DuplicateEventButton eventId="E1" raceDate="2026-11-14" apiUrl="/api/host/events/E1/duplicate" editHref="/host/events/{id}/edit" />)
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate$/ }))
    const date = screen.getByLabelText(/New date/)
    expect(date.value).toBe('2026-11-21')
    fireEvent.change(date, { target: { value: '2026-12-12' } })
    fireEvent.click(screen.getByRole('button', { name: /Create copy/ }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/host/events/E-new/edit'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/host/events/E1/duplicate')
    expect(JSON.parse(init.body)).toEqual({ race_date: '2026-12-12' })
  })
  it('shows the server\'s error inline and stays put', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'The copy could not be saved.' }) })))
    render(<DuplicateEventButton eventId="E1" raceDate="2026-11-14" apiUrl="/api/events/E1/duplicate" editHref="/events/{id}/edit" />)
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate$/ }))
    fireEvent.click(screen.getByRole('button', { name: /Create copy/ }))
    expect(await screen.findByText(/could not be saved/)).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
  })
})
