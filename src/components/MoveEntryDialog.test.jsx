// @vitest-environment jsdom
// EVENT-MOVE.1 — the move dialog: loads targets, shows the gap and the studio
// notice, posts the move, and turns a wave_full answer into Move anyway / Don't move.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import MoveEntryDialog from './MoveEntryDialog.jsx'

const TARGETS = {
  entry: { id: 'r1', label: 'The Crushers', headcount: 2, status: 'confirmed' },
  source: { event_id: 'e1', event_name: 'Hatch Oct 18', race_date: '2026-10-18', wave_id: 'w1', location_id: 'L1' },
  targets: [
    { id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', location_id: 'L1', location_name: 'Hatch St', crosses_studio: false, price_gap_cents: 1000, currency: 'EUR',
      waves: [{ id: 'w9', start_time: '11:00:00', label: null, capacity: 10, spots_left: 6 }, { id: 'w10', start_time: '12:30:00', label: null, capacity: 10, spots_left: 0 }] },
    { id: 'e4', name: 'Stillorgan Nov 1', race_date: '2026-11-01', location_id: 'L2', location_name: 'Stillorgan', crosses_studio: true, price_gap_cents: 0, currency: 'EUR', waves: [] },
  ],
}
const registration = { id: 'r1', status: 'confirmed', teams: { name: 'The Crushers', size: 2, team_members: [{ name: 'Aoife', role: 'captain', email: 'a@x.ie' }, { name: 'Dan' }] } }

function stubFetch(responses) {
  const fetchMock = vi.fn(async () => {
    const r = responses.shift()
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MoveEntryDialog', () => {
  it('lists targets, shows the price gap, and posts the move', async () => {
    const fetchMock = stubFetch([{ status: 200, body: { success: true, data: TARGETS } }, { status: 200, body: { success: true, data: {} } }])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    expect(screen.getByText(/€5\.00 more per person/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/event-registrations/r1/move')
    expect(JSON.parse(init.body)).toMatchObject({ target_event_id: 'e2', target_wave_id: 'w9', notify: true, force: false })
  })
  it('names the studio when the move crosses one', async () => {
    stubFetch([{ status: 200, body: { success: true, data: TARGETS } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e4' } })
    expect(screen.getByText(/moves the entry to Stillorgan/)).toBeTruthy()
  })
  it('wave_full offers Move anyway, which resends with force', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' } },
      { status: 200, body: { success: true, data: {} } },
    ])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This time is full/)
    fireEvent.click(screen.getByRole('button', { name: /Move anyway/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).force).toBe(true)
  })
  it("Don't move returns to the form without posting again", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' } },
    ])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This time is full/)
    fireEvent.click(screen.getByRole('button', { name: /Don't move/ }))
    expect(screen.getByRole('button', { name: /^Move entry$/ })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('says so when nothing is eligible', async () => {
    stubFetch([{ status: 200, body: { success: true, data: { ...TARGETS, targets: [] } } }])
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={() => {}} onError={() => {}} />)
    await screen.findByText(/No other upcoming events are paid to the same host/)
  })
  it('a conflict shows its message in the form, not the full-time choice', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 409, body: { success: false, error: 'conflict', message: 'This entry changed while you were moving it. Reload and try again.' } },
    ])
    const onMoved = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={() => {}} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await screen.findByText(/This entry changed while you were moving it/)
    expect(screen.queryByText(/This time is full/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Move anyway/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Move entry$/ })).toBeTruthy()
    expect(onMoved).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('tells staff when the customer could not be emailed, then closes as moved', async () => {
    stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 200, body: { success: true, data: { move: { id: 'mv1' }, registration: { id: 'r1' }, notified: false } } },
    ])
    const calls = []
    const onMoved = vi.fn(() => calls.push('moved'))
    const onError = vi.fn(() => calls.push('error'))
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={onError} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    expect(onError).toHaveBeenCalledWith('Moved. The customer could not be emailed; tell them yourself.')
    expect(calls).toEqual(['error', 'moved'])
  })
  it('says nothing about email when staff chose not to send one', async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { success: true, data: TARGETS } },
      { status: 200, body: { success: true, data: { move: { id: 'mv1' }, registration: { id: 'r1' }, notified: false } } },
    ])
    const onMoved = vi.fn()
    const onError = vi.fn()
    render(<MoveEntryDialog open registration={registration} onClose={() => {}} onMoved={onMoved} onError={onError} />)
    await screen.findByText(/Move The Crushers/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText(/^Time|^Wave/), { target: { value: 'w9' } })
    fireEvent.click(screen.getByLabelText(/Email Aoife/))
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    expect(onError).not.toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).notify).toBe(false)
  })
})
