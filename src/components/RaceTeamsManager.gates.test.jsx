// @vitest-environment jsdom
//
// C116 GATES-2 — "Cancel entry" calls POST /api/registrations/[id]/cancel,
// which requires MANAGER_ROLES at the event's studio. It showed to everyone
// who could open the teams page (`races`); the page now passes
// canCancelEntries, judged where the route judges it.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import RaceTeamsManager from './RaceTeamsManager.jsx'

const race = { id: 'e1', allowed_team_sizes: [2], waves: [{ id: 'w1', start_time: '09:00:00', label: 'Wave 1', display_order: 0 }] }
const registration = {
  id: 'r1', status: 'confirmed', team_name: 'Team One', team_size: 2, wave_id: 'w1',
  members: [], payment: null,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [registration] }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceTeamsManager — Cancel entry', () => {
  it('hidden without canCancelEntries (main: shown, then 403)', async () => {
    render(<RaceTeamsManager race={race} canCancelEntries={false} />)
    await screen.findByText(/1 team registered/)
    expect(screen.queryByRole('button', { name: /Cancel entry/ })).toBeNull()
  })
  it('the prop defaults to closed', async () => {
    render(<RaceTeamsManager race={race} />)
    await screen.findByText(/1 team registered/)
    expect(screen.queryByRole('button', { name: /Cancel entry/ })).toBeNull()
  })
  it('shown with canCancelEntries', async () => {
    render(<RaceTeamsManager race={race} canCancelEntries />)
    await screen.findByText(/1 team registered/)
    expect(screen.getByRole('button', { name: /Cancel entry/ })).toBeTruthy()
  })
})
