// @vitest-environment jsdom
//
// FINDTEAM.6 — the event form's "Find me a team" section: loads
// race_events.find_team, saves { enabled, ...non-blank copy } on every race
// save, and does not appear for other event kinds.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }) }))

const RACE = {
  id: 'ev-1', kind: 'race', name: 'Hyrox Sim', slug: 'hyrox-sim', race_date: '2026-11-03',
  allowed_team_sizes: [1, 2], capacity_mode: 'teams', active: true,
  waves: [{ id: 'w9', start_time: '09:00:00', capacity: 28, label: null }],
  find_team: { enabled: true, label: 'Need a team?' },
}

function stubFetch() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn((url, opts) => {
    calls.push({ url: String(url), opts })
    if (opts?.method === 'PUT' || opts?.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
    return new Promise(() => {})
  }))
  return calls
}

async function submitAndGetBody(container, calls) {
  fireEvent.submit(container.querySelector('form'))
  await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
  return JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceEventForm — Find me a team', () => {
  it('loads the saved switch and label and sends them back', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={RACE} locationId="loc-1" />)
    expect(screen.getByRole('switch', { name: 'Find me a team' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Choice label').value).toBe('Need a team?')
    const body = await submitAndGetBody(container, calls)
    expect(body.find_team.enabled).toBe(true)
    expect(body.find_team.label).toBe('Need a team?')
  })

  it('omits blank copy fields so the defaults apply', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={RACE} locationId="loc-1" />)
    const body = await submitAndGetBody(container, calls)
    for (const k of ['blurb', 'confirmation_paragraph', 'placed_subject', 'placed_intro']) {
      expect(k in body.find_team).toBe(false)
    }
    expect(JSON.stringify(body.find_team)).not.toContain('null')
  })

  it('sends the copy once typed, trimmed, including the placed email', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={RACE} locationId="loc-1" />)
    fireEvent.change(screen.getByLabelText('Short description'), { target: { value: '  We will pair you up.  ' } })
    fireEvent.change(screen.getByLabelText('Confirmation paragraph'), { target: { value: 'Solo place booked.' } })
    fireEvent.change(screen.getByPlaceholderText("You're on a team for {{event_name}}"), { target: { value: 'Team found' } })
    fireEvent.change(screen.getByPlaceholderText(/you've been placed with team/), { target: { value: 'Hi {{first_name}}' } })
    const body = await submitAndGetBody(container, calls)
    expect(body.find_team.blurb).toBe('We will pair you up.')
    expect(body.find_team.confirmation_paragraph).toBe('Solo place booked.')
    expect(body.find_team.placed_subject).toBe('Team found')
    expect(body.find_team.placed_intro).toBe('Hi {{first_name}}')
  })

  it('switching off sends enabled: false (and keeps the saved label)', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={RACE} locationId="loc-1" />)
    fireEvent.click(screen.getByRole('switch', { name: 'Find me a team' }))
    const body = await submitAndGetBody(container, calls)
    expect(body.find_team.enabled).toBe(false)
    expect(body.find_team.label).toBe('Need a team?')
  })

  it('an event with no saved settings shows the switch off and sends enabled: false', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...RACE, find_team: null }} locationId="loc-1" />)
    expect(screen.getByRole('switch', { name: 'Find me a team' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByLabelText('Choice label')).toBeNull()
    const body = await submitAndGetBody(container, calls)
    expect(body.find_team).toEqual({ enabled: false })
  })

  it('a non-race kind shows no section and sends no find_team', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...RACE, kind: 'workshop', allowed_team_sizes: [1], capacity_mode: 'people' }} locationId="loc-1" />)
    expect(screen.queryByRole('switch', { name: 'Find me a team' })).toBeNull()
    const body = await submitAndGetBody(container, calls)
    expect('find_team' in body).toBe(false)
  })
})
