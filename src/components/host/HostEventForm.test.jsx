// @vitest-environment jsdom
// HOSTSERIES.1 — the host form lists sessions: hydrates from initial.sessions,
// "Add a session" adds a row, and the body carries sessions[] only.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

const { default: HostEventForm } = await import('./HostEventForm.jsx')

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
const W2 = 'f0000000-0000-4000-8000-0000000000f2'
const initial = {
  kind: 'workshop', name: 'Mobility', venue_name: 'Studio 1', race_date: '2026-12-05', allowed_team_sizes: [1, 2],
  non_member_fee_cents: 2500,
  sessions: [{ id: W1, start_time: '10:00', label: null, capacity: 20 }, { id: W2, start_time: '14:00', label: 'Afternoon', capacity: 15 }],
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear() })

describe('HostEventForm sessions', () => {
  it('hydrates two sessions, adds a third, and submits sessions[] without the retired keys', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" />)

    expect(screen.getAllByLabelText(/Start time/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /Add a session/ }))
    const times = screen.getAllByLabelText(/Start time/)
    expect(times).toHaveLength(3)
    fireEvent.change(times[2], { target: { value: '18:00' } })
    fireEvent.change(screen.getAllByLabelText(/^Capacity/)[2], { target: { value: '8' } })

    fireEvent.click(screen.getByRole('button', { name: /Save changes|Save event|Create event/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/host/events/E1')
    const body = JSON.parse(init.body)
    expect(body.sessions).toEqual([
      { id: W1, start_time: '10:00', label: null, capacity: 20 },
      { id: W2, start_time: '14:00', label: 'Afternoon', capacity: 15 },
      { start_time: '18:00', label: null, capacity: 8 },
    ])
    expect(body).not.toHaveProperty('session_start_time')
    expect(body).not.toHaveProperty('session_capacity')
  })

  it('the only session cannot be removed; a second one can', () => {
    render(<HostEventForm mode="create" brandName="UN1T" />)
    expect(screen.getByRole('button', { name: /Remove session 1/ }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Add a session/ }))
    expect(screen.getByRole('button', { name: /Remove session 2/ }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Remove session 2/ }))
    expect(screen.getAllByLabelText(/Start time/)).toHaveLength(1)
  })

  it('refuses to submit when a session has no start time', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<HostEventForm mode="edit" eventId="E1" initial={{ ...initial, sessions: [{ id: W1, start_time: '', capacity: 20 }] }} brandName="UN1T" />)
    // The browser's own `required` check would stop a click here (jsdom
    // enforces it too); submit the form directly to exercise clientValidate.
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText(/Please set a start time for session 1/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
