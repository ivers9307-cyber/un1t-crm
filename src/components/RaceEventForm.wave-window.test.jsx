// @vitest-environment jsdom
//
// WAVEWIN.2 — the staff event form's "Start times on offer" setting: how
// wide the public wave picker's release window is for THIS event
// (race_events.wave_window_minutes, mig 825). Blank = the 90-minute default.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

const RACE = {
  id: 'race-1',
  name: 'Charity Day',
  slug: 'charity-day',
  kind: 'race',
  race_date: '2026-11-21',
  allowed_team_sizes: [2, 4],
  non_member_fee_cents: 5000,
  waves: [
    { id: 'w1', start_time: '08:00:00', capacity: 4, label: null, display_order: 0 },
    { id: 'w2', start_time: '08:45:00', capacity: 4, label: null, display_order: 1 },
    { id: 'w3', start_time: '09:30:00', capacity: 4, label: null, display_order: 2 },
    { id: 'w4', start_time: '10:15:00', capacity: 4, label: null, display_order: 3 },
    { id: 'w5', start_time: '11:00:00', capacity: 4, label: null, display_order: 4 },
  ],
}

let calls
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url, opts) => {
    calls.push({ url: String(url), opts })
    return new Promise(() => {})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const select = () => screen.getByLabelText('Start times on offer')
const savedBody = () => JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)

describe('RaceEventForm — wave window', () => {
  it('starts on the 90-minute default and says how many waves that opens', () => {
    render(<RaceEventForm race={RACE} locationId="loc-1" />)
    expect(select().value).toBe('')
    // 08:00 + 90 min → 08:00, 08:45, 09:30.
    expect(screen.getByText(/opens with 3 of the 5 waves/i)).toBeTruthy()
  })

  it('saves null while the default is selected', () => {
    const { container } = render(<RaceEventForm race={RACE} locationId="loc-1" />)
    fireEvent.submit(container.querySelector('form'))
    expect(savedBody().wave_window_minutes).toBeNull()
  })

  it('a wider window updates the count and is saved in minutes', () => {
    const { container } = render(<RaceEventForm race={RACE} locationId="loc-1" />)
    fireEvent.change(select(), { target: { value: '180' } })
    // 08:00 + 3 hours → all five (11:00 is the last).
    expect(screen.getByText(/opens with all 5 waves/i)).toBeTruthy()
    fireEvent.submit(container.querySelector('form'))
    expect(savedBody().wave_window_minutes).toBe(180)
  })

  it('loads the saved window, and keeps a value that is not one of the presets', () => {
    render(<RaceEventForm race={{ ...RACE, wave_window_minutes: 150 }} locationId="loc-1" />)
    expect(select().value).toBe('150')
    // 08:00 + 150 min → 10:30, so 10:15 is in and 11:00 is not.
    expect(screen.getByText(/opens with 4 of the 5 waves/i)).toBeTruthy()
  })

  it('is not shown for a non-race kind, and saves null there', () => {
    const { container } = render(<RaceEventForm race={{ ...RACE, kind: 'workshop', wave_window_minutes: 180 }} locationId="loc-1" />)
    expect(screen.queryByLabelText('Start times on offer')).toBeNull()
    fireEvent.submit(container.querySelector('form'))
    expect(savedBody().wave_window_minutes).toBeNull()
  })
})
