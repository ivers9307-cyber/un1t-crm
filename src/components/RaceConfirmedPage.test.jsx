// @vitest-environment jsdom
//
// W1.L5 — the "Add to calendar" file on the post-payment page carries the
// TENANT's identity (brand + host, passed in by the server page), never the
// platform's first gym.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import RaceConfirmedPage from './RaceConfirmedPage'

const REGISTRATION = {
  id: 'reg-1',
  status: 'confirmed',
  race: {
    id: 'ev-1', name: '', slug: 'gym-a-nov1-1000', kind: 'race', race_date: '2026-11-01', location_id: 'loc-a',
    locations: { name: 'Gym A North', address: 'Unit 4, Somewhere' },
  },
  wave: { id: 'w1', start_time: '10:00:00', label: null },
  team: { id: 't1', name: 'Team A', size: 2, team_members: [{ id: 'm1', name: 'Pat', role: 'captain', is_member: false }] },
}

function mockFetch(data) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data }) }))
}

afterEach(() => { cleanup(); delete global.fetch; vi.restoreAllMocks() })

async function icsFor(props) {
  render(<RaceConfirmedPage slug="gym-a-nov1-1000" registrationId="reg-1" {...props} />)
  const link = await screen.findByRole('link', { name: /add to calendar/i })
  const href = link.getAttribute('href')
  expect(href.startsWith('data:text/calendar;charset=utf8,')).toBe(true)
  return decodeURIComponent(href.slice('data:text/calendar;charset=utf8,'.length))
}

describe('RaceConfirmedPage calendar file (W1.L5)', () => {
  it('names the tenant brand and host, never UN1T', async () => {
    mockFetch(REGISTRATION)
    const ics = await icsFor({ brandName: 'Gym A', hostname: 'gym-a.repset.ie' })
    expect(ics).toContain('PRODID:-//Repset//Events//EN')
    expect(ics).toContain('UID:reg-1@gym-a.repset.ie')
    expect(ics).toContain('SUMMARY:Gym A event') // the event has no name → brand fallback
    expect(ics).toContain('DTSTART:20261101T100000')
    expect(ics).toContain('LOCATION:Unit 4\\, Somewhere')
    expect(ics).toContain('DESCRIPTION:Team Team A')
    expect(ics).not.toContain('UN1T')
    expect(ics).not.toContain('un1tdublin')
  })

  it('an event with a name keeps it as the summary', async () => {
    mockFetch({ ...REGISTRATION, race: { ...REGISTRATION.race, name: 'Hatch 10K' } })
    const ics = await icsFor({ brandName: 'Gym A', hostname: 'gym-a.repset.ie' })
    expect(ics).toContain('SUMMARY:Hatch 10K')
  })

  it('with no identity props at all the file still has no first-gym literal', async () => {
    mockFetch(REGISTRATION)
    const ics = await icsFor({})
    expect(ics).toContain('SUMMARY:Event')
    expect(ics).toContain('UID:reg-1@repset.ie')
    expect(ics).not.toContain('UN1T')
  })
})
