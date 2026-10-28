// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const { default: AppUsageReport } = await import('./AppUsageReport.jsx')

const people = {
  range: { key: '7d', from: '2026-10-20', to: '2026-10-26', days: 7 },
  view: 'people',
  platform: 'all',
  rows: [
    { profileId: 'a', name: 'Aoife', tenant: 'UN1T Group', lastActiveAt: null, daysUsed: 6, sessions: 35, sessionsPerDay: 5, seconds: 21900, phoneSeconds: 15000, webSeconds: 7000, phoneShare: 0.68 },
    { profileId: 'd', name: 'Darragh', tenant: 'UN1T Group', lastActiveAt: null, daysUsed: 0, sessions: 0, sessionsPerDay: 0, seconds: 0, phoneSeconds: 0, webSeconds: 0, phoneShare: null },
  ],
  totals: { activeStaff: 1, staffCount: 2, sessions: 35, seconds: 21900, topFeature: 'Contacts' },
  organizations: [{ id: 'o1', name: 'UN1T Group' }, { id: 'o2', name: 'CCF Autos' }],
  locations: [{ id: 'l1', name: 'Stillorgan', organization_id: 'o1' }],
}
const features = {
  ...people,
  view: 'features',
  rows: [{ feature: 'contacts', label: 'Contacts', people: 1, visits: 50, visitsPerDay: 7.1, seconds: 6000, avgVisitSec: 120 }],
}
const person = {
  range: people.range,
  person: people.rows[0],
  features: features.rows,
  day: '2026-10-26',
  timelineAvailable: true,
  timeline: [{ sessionId: 's1', platform: 'phone', startedAt: '2026-10-26T07:05:00Z', endedAt: '2026-10-26T07:20:00Z', trail: [{ feature: 'schedule', label: 'Rota', seconds: 900 }] }],
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url) => {
    const data = url.includes('/app-usage/a') ? person : url.includes('view=features') ? features : people
    return { ok: true, status: 200, json: async () => ({ success: true, data }) }
  })
})
afterEach(() => cleanup())

describe('AppUsageReport', () => {
  it('shows the summary and the Who table, unused staff included', async () => {
    render(<AppUsageReport />)
    expect(await screen.findByText('Aoife')).toBeTruthy()
    expect(screen.getByText('Darragh')).toBeTruthy()
    expect(screen.getByText('1 / 2')).toBeTruthy()
    expect(screen.getAllByText('6h 05m')).toHaveLength(2) // the card and Aoife's row
    expect(screen.getByText('68% / 32%')).toBeTruthy()
    expect(screen.getAllByText('UN1T Group').length).toBeGreaterThan(0)
  })

  it('flips to By feature', async () => {
    render(<AppUsageReport />)
    await screen.findByText('Aoife')
    fireEvent.click(screen.getByRole('button', { name: 'By feature' }))
    expect(await screen.findByText('2m')).toBeTruthy()
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('view=features'), expect.anything())
  })

  it('opens a person with their features and the session trail', async () => {
    render(<AppUsageReport />)
    fireEvent.click(await screen.findByText('Aoife'))
    expect(await screen.findByText('Aoife by feature')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /phone session/ }))
    expect(screen.getByText(/Rota 15m/)).toBeTruthy()
  })
})
