// @vitest-environment jsdom
//
// EVENT-WAITLIST.1 — the teams page shows the waitlist section only with
// canManageWaitlist (the waitlist routes' rule), defaulting closed.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import RaceTeamsManager from './RaceTeamsManager.jsx'

const race = { id: 'e1', allowed_team_sizes: [1], waves: [{ id: 'w1', start_time: '09:00:00', label: null, display_order: 0 }] }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('/waitlist')
      ? { success: true, data: { rows: [{ id: 'a', name: 'Ann Example', email: 'ann@example.test', status: 'waiting', headcount: 1 }], waiting: 1 } }
      : { success: true, data: [] }),
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceTeamsManager — waitlist section', () => {
  it('hidden by default', async () => {
    render(<RaceTeamsManager race={race} />)
    await screen.findByText(/0 teams registered/)
    expect(screen.queryByRole('region', { name: 'Waitlist' })).toBeNull()
  })
  it('shown with canManageWaitlist, with the count for staff', async () => {
    render(<RaceTeamsManager race={race} canManageWaitlist />)
    expect(await screen.findByRole('heading', { name: 'Waitlist (1 waiting)' })).toBeTruthy()
    expect(screen.getByText('Ann Example')).toBeTruthy()
  })
})
