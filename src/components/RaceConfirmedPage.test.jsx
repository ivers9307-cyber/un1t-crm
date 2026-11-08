// @vitest-environment jsdom
//
// CALENDAR.1 — the post-payment page's "Add to calendar" is two links the
// server built (the .ics route, which carries the tenant's identity and the
// studio-zone instant, and a Google template link). W1.L5's concern (never
// the platform's first gym in the file) now lives in the .ics route and its
// test; this page only renders what the data carries, and nothing when the
// event has no session instant.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import RaceConfirmedPage from './RaceConfirmedPage'

const CALENDAR = {
  ics_url: 'https://gym-a.repset.ie/api/public/events/gym-a-nov1-1000/calendar.ics?wave=w1',
  google_url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Hatch+10K',
  starts_at: '2026-11-01T10:00:00.000Z', ends_at: '2026-11-01T12:00:00.000Z',
}
const REGISTRATION = {
  id: 'reg-1',
  status: 'confirmed',
  race: {
    id: 'ev-1', name: 'Hatch 10K', slug: 'gym-a-nov1-1000', kind: 'race', race_date: '2026-11-01', location_id: 'loc-a',
    locations: { name: 'Gym A North', address: 'Unit 4, Somewhere' },
  },
  wave: { id: 'w1', start_time: '10:00:00', label: null },
  team: { id: 't1', name: 'Team A', size: 2, team_members: [{ id: 'm1', name: 'Pat', role: 'captain', is_member: false }] },
  calendar: CALENDAR,
}

function mockFetch(data) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data }) }))
}
afterEach(() => { cleanup(); delete global.fetch; vi.restoreAllMocks() })

describe('RaceConfirmedPage add to calendar (CALENDAR.1)', () => {
  it('links the .ics route and Google from the data, never a data: file', async () => {
    mockFetch(REGISTRATION)
    render(<RaceConfirmedPage slug="gym-a-nov1-1000" registrationId="reg-1" />)
    const apple = await screen.findByRole('link', { name: /Apple \/ Outlook/ })
    expect(apple.getAttribute('href')).toBe(CALENDAR.ics_url)
    expect(screen.getByRole('link', { name: /Google/ }).getAttribute('href')).toBe(CALENDAR.google_url)
    expect(document.body.innerHTML).not.toContain('data:text/calendar')
  })
  it('renders no calendar links when the data has none', async () => {
    mockFetch({ ...REGISTRATION, calendar: null })
    render(<RaceConfirmedPage slug="gym-a-nov1-1000" registrationId="reg-1" />)
    await waitFor(() => expect(screen.getAllByText(/Hatch 10K/).length).toBeGreaterThan(0))
    expect(screen.queryByRole('link', { name: /Apple \/ Outlook/ })).toBeNull()
    expect(screen.queryByText(/add to calendar/i)).toBeNull()
  })
})
