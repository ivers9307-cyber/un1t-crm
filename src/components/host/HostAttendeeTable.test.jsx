// @vitest-environment jsdom
// EVENT-MOVE.2 — the host attendee table: one row per entry, Move for paid
// entries, Pay first for unpaid, chips from last_move, moved-out footer, and
// the dialog wired to the host routes.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const { default: HostAttendeeTable } = await import('./HostAttendeeTable.jsx')

const entries = [
  { id: 'r1', status: 'confirmed', label: 'The Crushers', people: [{ name: 'Aoife Byrne', email: 'a@x.ie' }, { name: 'Dan Walsh', email: '' }], wave: '11:00', phone: '+3531', last_move: { id: 'm1', created_at: '2026-10-06T10:00:00Z', actor_name: 'Colm', notified_at: null, forced: false, from_event: { id: 'e0', name: 'PTC Oct 4', race_date: '2026-10-04' } }, registration: { id: 'r1', status: 'confirmed', teams: { name: 'The Crushers', size: 2, team_members: [{ name: 'Aoife Byrne', role: 'captain', email: 'a@x.ie' }, { name: 'Dan Walsh' }] } } },
  { id: 'r2', status: 'pending_payment', label: 'Mark Kelly', people: [{ name: 'Mark Kelly', email: 'm@x.ie' }], wave: '11:00', phone: '', last_move: null, registration: { id: 'r2', status: 'pending_payment', teams: { name: 'Mark Kelly', size: 1, team_members: [{ name: 'Mark Kelly', role: 'captain' }] } } },
]
const movedOut = [{ id: 'o1', created_at: '2026-10-07T10:00:00Z', actor_name: 'Colm', label: 'Wolves', to_event: { id: 'e5', name: 'PTC Nov 1', race_date: '2026-11-01' } }]

afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

describe('HostAttendeeTable', () => {
  it('renders one row per entry with its people, Move for paid and Pay first for unpaid', () => {
    render(<HostAttendeeTable entries={entries} movedOut={[]} />)
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + 2
    expect(screen.getByText('Aoife Byrne')).toBeTruthy()
    expect(screen.getByText('Dan Walsh')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Move$/ })).toHaveLength(1)
    expect(screen.getByText(/Pay first/)).toBeTruthy()
  })
  it('offers no Move on a cancelled entry', () => {
    const cancelled = { ...entries[0], id: 'r3', status: 'cancelled', last_move: null, registration: { ...entries[0].registration, id: 'r3', status: 'cancelled' } }
    render(<HostAttendeeTable entries={[cancelled]} movedOut={[]} />)
    expect(screen.queryByRole('button', { name: /^Move$/ })).toBeNull()
    expect(screen.queryByText(/Pay first/)).toBeNull()
    expect(screen.getByText('Cancelled')).toBeTruthy()
  })
  it('shows each person on their own line with their email as visible text', () => {
    render(<HostAttendeeTable entries={entries} movedOut={[]} />)
    expect(screen.getByText(/a@x\.ie/)).toBeTruthy()
    expect(screen.getByText(/m@x\.ie/)).toBeTruthy()
    expect(screen.getByText('Aoife Byrne').closest('td').getAttribute('title')).toBeNull()
  })
  it('shows moved-in and not-emailed chips', () => {
    render(<HostAttendeeTable entries={entries} movedOut={[]} />)
    expect(screen.getByText(/moved in from PTC Oct 4/i)).toBeTruthy()
    expect(screen.getByText(/Not emailed/)).toBeTruthy()
  })
  it('lists moves out', () => {
    render(<HostAttendeeTable entries={entries} movedOut={movedOut} />)
    expect(screen.getByText(/1 move to other events/)).toBeTruthy()
    expect(screen.getByText(/Wolves/)).toBeTruthy()
  })
  it('opens the dialog against the host routes', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { entry: { id: 'r1', label: 'The Crushers', headcount: 2 }, source: {}, targets: [] } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostAttendeeTable entries={entries} movedOut={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))
    await screen.findByText(/Move The Crushers to another event/)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/host/registrations/r1/move-targets')
  })
  it('after a move that could not be emailed, refreshes the roster and keeps the notice', async () => {
    const targets = [{ id: 'e2', name: 'PTC Oct 18', race_date: '2026-10-18', location_name: 'Hatch', price_gap_cents: 0, waves: [] }]
    const fetchMock = vi.fn(async (url) => url.endsWith('/move-targets')
      ? { ok: true, status: 200, json: async () => ({ success: true, data: { entry: { id: 'r1', label: 'The Crushers', headcount: 2 }, source: {}, targets } }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { notified: false } }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<HostAttendeeTable entries={entries} movedOut={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))
    await screen.findByText(/Move The Crushers to another event/)
    const select = await screen.findByLabelText(/event/i, { selector: 'select' })
    fireEvent.change(select, { target: { value: 'e2' } })
    fireEvent.click(screen.getByRole('button', { name: /Move entry/ }))
    // The notice names the entry: the moved row has left this event's list.
    await screen.findByText('The Crushers: Moved. The customer could not be emailed; tell them yourself.')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/host/registrations/r1/move')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Move The Crushers to another event/)).toBeNull()
    // Starting another move clears the old notice.
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))
    expect(screen.queryByText(/could not be emailed/)).toBeNull()
  })
  it('renders nothing but the empty line with no entries', () => {
    render(<HostAttendeeTable entries={[]} movedOut={[]} />)
    expect(screen.getByText(/No attendees yet/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
