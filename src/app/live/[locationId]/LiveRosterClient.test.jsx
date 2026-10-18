// @vitest-environment jsdom
//
// UN1TBOOK.13 — the roster-only /live view for `class_roster` holders. It polls
// /api/live/<id>/roster every 15 s and renders ONLY the who's-coming list:
// none of the HR board's grid, straps, pairing, Detected tab or test mode.
//
// Fake-timer rule (CLAUDE.md): the clock advances INSIDE act().
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import LiveRosterClient from './LiveRosterClient.jsx'

const OCC = { glofox_event_id: 'ev1', class_name: 'Strength 6pm', ends_at: null }
const ROSTER = [
  { label: 'Aoife B', booked: true, hasHr: false, anon: false, currentBpm: null, sessionId: null },
  { label: 'Conor D', booked: true, hasHr: false, anon: false, currentBpm: null, sessionId: null },
]

let payload
let fetchMock

function respond(body) {
  payload = body
}

async function mount() {
  await act(async () => {
    render(<LiveRosterClient locationId="loc1" locationName="Hatch Street" timeZone="Europe/Dublin" />)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  respond({ ok: true, occurrence: OCC, roster: ROSTER, has_bridge: false })
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('LiveRosterClient', () => {
  it('shows "{n} booked" without a bridge', async () => {
    await mount()
    expect(screen.getByText(/^2 booked$/)).toBeTruthy()
    expect(screen.getByText('Aoife B')).toBeTruthy()
    expect(screen.queryByText(/no strap/)).toBeNull()
  })

  it('never shows booked-here or strap state, even when has_bridge is true', async () => {
    respond({
      ok: true,
      occurrence: OCC,
      roster: [{ ...ROSTER[0], hasHr: true, currentBpm: 120, sessionId: 's1' }, ROSTER[1]],
      has_bridge: true,
    })
    await mount()
    expect(screen.getByText(/^2 booked$/)).toBeTruthy()
    expect(screen.queryByText(/booked here/)).toBeNull()
    expect(screen.queryByText(/no strap/)).toBeNull()
    expect(screen.queryByText(/bpm/)).toBeNull()
    expect(screen.queryByText('120')).toBeNull()
  })

  it('shows the empty state with no live class', async () => {
    respond({ ok: true, occurrence: null, roster: [], has_bridge: false })
    await mount()
    expect(screen.getByText('No class on right now. The list opens 20 minutes before a class starts.')).toBeTruthy()
  })

  it('says so when a class is live and nobody is booked', async () => {
    respond({ ok: true, occurrence: OCC, roster: [], has_bridge: true })
    await mount()
    expect(screen.getByText('Nobody is booked into Strength 6pm.')).toBeTruthy()
  })

  it('renders no HR grid, straps, pairing, Detected tab or test-mode control', async () => {
    await mount()
    expect(screen.queryByText(/No active sessions/)).toBeNull()
    expect(screen.queryByText(/Available straps/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Pair/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Detected/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Live board/ })).toBeNull()
    expect(screen.queryByText(/HR test mode/)).toBeNull()
    expect(screen.queryByRole('button', { name: /End all/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /TV display/ })).toBeNull()
  })

  it('polls the roster route (and only that) every 15 s', async () => {
    await mount()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/live/loc1/roster')
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([u]) => u === '/api/live/loc1/roster')).toBe(true)
  })

  it('picks up a changed roster on the next poll', async () => {
    await mount()
    respond({ ok: true, occurrence: null, roster: [], has_bridge: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByText(/No class on right now/)).toBeTruthy()
  })

  it('shows the error and keeps polling when the route refuses', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'Forbidden' }) }))
    await mount()
    expect(screen.getByText('Forbidden')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Forbidden')).toBeNull()
  })
})
