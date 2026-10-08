// @vitest-environment jsdom
// EVENT-MOVE.1 — Move to event is gated like Cancel entry, the chip reads the
// last move in, and the footer lists moves out.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaceTeamsManager from './RaceTeamsManager.jsx'

const race = { id: 'e2', allowed_team_sizes: [2], waves: [{ id: 'w9', start_time: '11:00:00', label: null, display_order: 0 }] }
const reg = {
  id: 'r1', status: 'confirmed', wave_id: 'w9', payment: null,
  teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [] },
  last_move: { id: 'mv1', created_at: '2026-10-08T09:00:00Z', actor_name: 'Richard', price_gap_cents: 1000, forced: false, notified_at: '2026-10-08T09:00:04Z', from_event: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18' } },
}
const movedOut = [{ id: 'mv2', created_at: '2026-10-08T10:00:00Z', actor_name: 'Richard', label: 'Wolves', to_event: { id: 'e5', name: 'Hatch Nov 1', race_date: '2026-11-01' } }]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [reg], moved_out: movedOut }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceTeamsManager — Move to event', () => {
  it('hidden without canMoveEntries', async () => {
    render(<RaceTeamsManager race={race} canMoveEntries={false} />)
    await screen.findByText(/1 team registered/)
    expect(screen.queryByRole('button', { name: /Move to event/ })).toBeNull()
  })
  it('shown with canMoveEntries', async () => {
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/1 team registered/)
    expect(screen.getByRole('button', { name: /Move to event/ })).toBeTruthy()
  })
  it('shows the Moved from chip and the outstanding gap', async () => {
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/Moved from Hatch Oct 18/)
    expect(screen.getByText(/€10\.00 difference outstanding/)).toBeTruthy()
  })
  it('lists entries moved out of this event', async () => {
    render(<RaceTeamsManager race={race} />)
    await screen.findByText(/1 entry moved to other events/)
    expect(screen.getByText(/Wolves/)).toBeTruthy()
    expect(screen.getByText(/Hatch Nov 1/)).toBeTruthy()
  })
  it('says Not emailed when the move in was not emailed', async () => {
    const unsent = { ...reg, last_move: { ...reg.last_move, notified_at: null } }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [unsent], moved_out: [] }) })))
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/Moved from Hatch Oct 18/)
    const chip = screen.getByText(/Not emailed/)
    expect(chip.getAttribute('title')).toBe('The customer was not emailed about this move. Tell them yourself.')
  })
  it('no Not emailed chip when the move was emailed', async () => {
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/Moved from Hatch Oct 18/)
    expect(screen.queryByText(/Not emailed/)).toBeNull()
  })
  it('no footer when nothing moved out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [reg], moved_out: [] }) })))
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/1 team registered/)
    expect(screen.queryByText(/moved to other events/)).toBeNull()
  })
  it('Move to event is hidden on a cancelled entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [{ ...reg, status: 'cancelled' }], moved_out: [] }) })))
    render(<RaceTeamsManager race={race} canMoveEntries />)
    await screen.findByText(/1 team registered/)
    expect(screen.queryByRole('button', { name: /Move to event/ })).toBeNull()
  })
  it('a move that could not be emailed leaves an amber notice, dismissable, not the error banner', async () => {
    const TARGETS = {
      entry: { id: 'r1', label: 'The Crushers', headcount: 2, status: 'confirmed' },
      source: { event_id: 'e2', event_name: 'Hatch Oct 25', race_date: '2026-10-25', wave_id: 'w9', location_id: 'L1' },
      targets: [{ id: 'e7', name: 'Hatch Nov 8', race_date: '2026-11-08', location_id: 'L1', location_name: 'Hatch St', crosses_studio: false, price_gap_cents: 0, currency: 'EUR',
        waves: [{ id: 'w70', start_time: '11:00:00', label: null, capacity: 10, spots_left: 4 }] }],
    }
    const fetchMock = vi.fn(async (url, init) => {
      if (url.endsWith('/move-targets')) return { ok: true, status: 200, json: async () => ({ success: true, data: TARGETS }) }
      if (url.endsWith('/move') && init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true, data: { move: { id: 'mv9' }, registration: { id: 'r1' }, notified: false } }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [reg], moved_out: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<RaceTeamsManager race={race} canMoveEntries />)
    fireEvent.click(await screen.findByRole('button', { name: /Move to event/ }))
    await screen.findByText(/to another event/)
    fireEvent.change(screen.getByLabelText(/Target event/), { target: { value: 'e7' } })
    fireEvent.change(screen.getByLabelText(/^Time$/), { target: { value: 'w70' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move entry$/ }))
    const notice = await screen.findByText(/The customer could not be emailed; tell them yourself\./)
    const banner = notice.closest('[role="status"]')
    expect(banner).toBeTruthy()
    expect(banner.className).toContain('bg-amber-500/10')
    expect(banner.className).toContain('text-amber-700')
    expect(banner.className).not.toContain('red')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Dismiss notice/ }))
    expect(screen.queryByText(/could not be emailed/)).toBeNull()
  })
})
