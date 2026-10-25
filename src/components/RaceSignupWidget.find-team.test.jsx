// @vitest-environment jsdom
//
// FINDTEAM.4 — "Find me a team" is the FIRST option in a race's size selector
// when the event has it on. Choosing it hides the team-name and teammate fields,
// shows the blurb, prices one person, and registers a solo entry (find_team: true,
// no team_name / team_size / members). With the option off the selector is unchanged.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const BLURB = 'No team? No problem. Register on your own and we will place you with a team before race day.'

const RACE = {
  id: 'ev-1', name: 'Hyrox Relay', slug: 'hatch-relay', kind: 'race', race_date: '2026-11-21',
  allowed_team_sizes: [2, 4], capacity_mode: 'teams',
  waves: [{ id: 'w1', start_time: '10:00:00', label: null, is_full: false }],
  registration_state: 'open', payment_currency: 'EUR', members_only: false, organization_name: 'UN1T',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 5000,
  find_team: { enabled: true, label: 'Find me a team', blurb: BLURB },
}

const jsonRes = (body) => ({
  ok: true, status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
})

function serve(data) {
  const fetchMock = vi.fn((url) => {
    if (String(url).endsWith('/register')) {
      return Promise.resolve(jsonRes({ success: true, data: { registration_id: 'r1', payment: { free: true } } }))
    }
    return Promise.resolve(jsonRes({ success: true, data }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function renderWidget(data) {
  const fetchMock = serve(data)
  render(<RaceSignupWidget slug="hatch-relay" />)
  await screen.findByPlaceholderText('Your email *')
  return fetchMock
}

// The size selector is the flex row of pills that follows the "Team size *" label.
const selectorTexts = () => {
  const label = screen.getByText('Team size *')
  return [...label.nextElementSibling.querySelectorAll('button')].map((b) => b.textContent)
}

// The submit button renders twice (desktop and the mobile sticky bar), each with an arrow.
const submitLabels = () => [...new Set(
  [...document.querySelectorAll('button[type="submit"]')].map((b) => b.textContent.replace('→', '').trim()),
)]

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceSignupWidget — Find me a team', () => {
  it('offers the option first, then the sizes, and never preselects it', async () => {
    await renderWidget(RACE)
    expect(selectorTexts()).toEqual(['Find me a team', '2-people', '4-people'])
    // The smallest size stays the default: the teammate rows for a team of 2 show.
    expect(screen.getByText('Team name *')).toBeTruthy()
    expect(await screen.findByText('Your teammates')).toBeTruthy()
    expect(screen.queryByText(BLURB)).toBeNull()
  })

  it('choosing it hides the team name and teammates, shows the blurb and prices one person', async () => {
    await renderWidget(RACE)
    await screen.findByText('Your teammates')
    fireEvent.click(screen.getByRole('button', { name: 'Find me a team' }))
    expect(screen.queryByText('Team name *')).toBeNull()
    await waitFor(() => expect(screen.queryByText('Your teammates')).toBeNull())
    expect(screen.getByText(BLURB)).toBeTruthy()
    expect(submitLabels()).toEqual(['Register and pay €50.00'])
  })

  it('choosing a size afterwards brings the team fields back and drops the blurb', async () => {
    await renderWidget(RACE)
    await screen.findByText('Your teammates')
    fireEvent.click(screen.getByRole('button', { name: 'Find me a team' }))
    fireEvent.click(screen.getByRole('button', { name: '4-people' }))
    expect(screen.getByText('Team name *')).toBeTruthy()
    expect(await screen.findByText('Your teammates')).toBeTruthy()
    expect(screen.queryByText(BLURB)).toBeNull()
    await waitFor(() => expect(submitLabels()).toEqual(['Register and pay €200.00']))
  })

  it('submits find_team: true with no team_name, team_size or members', async () => {
    const fetchMock = await renderWidget(RACE)
    fireEvent.click(screen.getByRole('button', { name: 'Find me a team' }))
    const form = document.getElementById('event-signup-form-hatch-relay')
    for (const el of form.querySelectorAll('input')) {
      if (el.type === 'email') fireEvent.change(el, { target: { value: 'ann@example.test' } })
      else if (el.type === 'tel') fireEvent.change(el, { target: { value: '0870000000' } })
      else if (el.type === 'text' && !el.value) fireEvent.change(el, { target: { value: 'Ann Example' } })
    }
    fireEvent.submit(form)
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2))
    const [url, init] = fetchMock.mock.calls[1]
    expect(String(url)).toBe('/api/public/events/hatch-relay/register')
    const body = JSON.parse(init.body)
    expect(body.find_team).toBe(true)
    expect(body).not.toHaveProperty('members')
    expect(body).not.toHaveProperty('team_name')
    expect(body).not.toHaveProperty('team_size')
    expect(body).toMatchObject({
      wave_id: 'w1', captain_name: 'Ann Example', captain_email: 'ann@example.test',
      captain_phone: '0870000000', source: 'race_signup_widget',
    })
  })

  it('without the option the selector is unchanged and there is no blurb', async () => {
    const { find_team: _drop, ...noOption } = RACE
    await renderWidget(noOption)
    expect(selectorTexts()).toEqual(['2-people', '4-people'])
    expect(screen.queryByText(BLURB)).toBeNull()
  })

  it('a disabled option is not offered', async () => {
    await renderWidget({ ...RACE, find_team: { enabled: false, label: 'Find me a team', blurb: BLURB } })
    expect(selectorTexts()).toEqual(['2-people', '4-people'])
  })

  it('a team registration still sends its team_name, team_size and members', async () => {
    const fetchMock = await renderWidget(RACE)
    await screen.findByText('Your teammates')
    const form = document.getElementById('event-signup-form-hatch-relay')
    for (const el of form.querySelectorAll('input')) {
      if (el.type === 'email') fireEvent.change(el, { target: { value: el.placeholder.startsWith('Your') ? 'ann@example.test' : 'bo@example.test' } })
      else if (el.type === 'tel') fireEvent.change(el, { target: { value: '0870000000' } })
      else if (el.type === 'text' && !el.value) fireEvent.change(el, { target: { value: 'Iron Dogs' } })
    }
    fireEvent.submit(form)
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body).not.toHaveProperty('find_team')
    expect(body.team_size).toBe(2)
    expect(body.team_name).toBe('Iron Dogs')
    expect(body.members).toHaveLength(1)
  })
})
