// @vitest-environment jsdom
// CALENDAR.1 — the public event page offers "Add to calendar" from the
// payload's per-wave links: always for a single-time event, only after a
// time is picked for a multi-time one, never without links.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const links = (w) => ({ ics_url: `https://x/api/public/events/mob/calendar.ics?wave=${w}`, google_url: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=Mob&w=${w}` })
const RACE = {
  id: 'ev-1', name: 'Mobility', slug: 'mob', kind: 'workshop', race_date: '2026-12-05',
  allowed_team_sizes: [1, 2], capacity_mode: 'people',
  waves: [{ id: 'w1', start_time: '10:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2500,
  calendar: { by_wave: { w1: links('w1') } },
}
const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body })
async function renderWidget(data) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonRes({ success: true, data }))))
  render(<RaceSignupWidget slug="mob" />)
  await screen.findByPlaceholderText('Your email *')
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceSignupWidget — add to calendar', () => {
  it('a single-time event shows both links straight away', async () => {
    await renderWidget(RACE)
    expect(screen.getByRole('link', { name: /Apple \/ Outlook/ }).getAttribute('href')).toBe(links('w1').ics_url)
    expect(screen.getByRole('link', { name: /Google/ }).getAttribute('href')).toBe(links('w1').google_url)
  })
  it('a multi-time event shows the links only once a time is picked', async () => {
    const two = { ...RACE, waves: [...RACE.waves, { id: 'w2', start_time: '14:00:00', label: null, is_full: false }], calendar: { by_wave: { w1: links('w1'), w2: links('w2') } } }
    await renderWidget(two)
    expect(screen.queryByRole('link', { name: /Apple \/ Outlook/ })).toBeNull()
    fireEvent.click(screen.getByTitle('14:00'))
    expect(screen.getByRole('link', { name: /Apple \/ Outlook/ }).getAttribute('href')).toBe(links('w2').ics_url)
  })
  it('no links in the payload → no calendar row', async () => {
    await renderWidget({ ...RACE, calendar: undefined })
    expect(screen.queryByRole('link', { name: /Apple \/ Outlook/ })).toBeNull()
  })
})
