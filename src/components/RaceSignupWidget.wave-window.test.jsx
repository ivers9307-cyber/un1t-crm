// @vitest-environment jsdom
//
// WAVEWIN.1 — the public wave picker only offers the immediately-
// available 90-minute window. Earlier sold-out waves stay visible and
// disabled; later waves are hidden behind a "released as waves fill"
// hint. The sidebar schedule summary still lists the full day.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const RACE = {
  id: 'race-1',
  name: 'Test Race',
  slug: 'test-race',
  kind: 'race',
  race_date: '2026-09-05',
  allowed_team_sizes: [2],
  waves: [
    { id: 'w1', start_time: '09:00:00', label: null, is_full: true },
    { id: 'w2', start_time: '10:00:00', label: null, is_full: false },
    { id: 'w3', start_time: '10:30:00', label: null, is_full: false },
    { id: 'w4', start_time: '11:30:00', label: null, is_full: false },
    { id: 'w5', start_time: '14:00:00', label: null, is_full: false },
  ],
  registration_state: 'open',
  member_pricing_enabled: false,
  non_member_fee_cents: 2500,
  payment_currency: 'EUR',
  members_only: false,
}

function jsonRes(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).includes('/api/public/events/')) {
      return Promise.resolve(jsonRes({ success: true, data: RACE }))
    }
    return Promise.resolve(jsonRes({ success: false }))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceSignupWidget — 90-minute wave window', () => {
  it('offers only the window, greys the earlier sold-out wave, hides later waves', async () => {
    render(<RaceSignupWidget slug="test-race" />)
    await screen.findByText('Pick your wave *')

    // Earlier sold-out wave: visible but disabled.
    const soldOut = screen.getByRole('button', { name: /09:00/ })
    expect(soldOut.disabled).toBe(true)

    // The available window: 10:00 anchor → 11:30 inclusive.
    expect(screen.getByRole('button', { name: /^10:00$/ }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: /^10:30$/ }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: /^11:30$/ }).disabled).toBe(false)

    // 14:00 is beyond the window — no button for it.
    expect(screen.queryByRole('button', { name: /14:00/ })).toBeNull()

    // The hold-back is explained.
    expect(screen.getByText(/released as these waves fill/i)).toBeTruthy()

    // The sidebar summary still describes the whole day (5 waves).
    expect(document.body.textContent).toContain('5 waves')
  })
})
