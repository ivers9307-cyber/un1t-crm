// @vitest-environment jsdom
//
// EVENT-MULTITIME.1 — a non-race event with more than one start time
// (e.g. an 8am and a 9am class) shows a "Choose your time" picker with
// every time, and makes the customer pick rather than silently booking
// the first. A single-time event is unchanged: no picker, time in the
// details card.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import RaceSignupWidget from './RaceSignupWidget.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const base = {
  id: 'ev-1',
  name: 'Opening Day',
  slug: 'opening-day',
  kind: 'open_day',
  race_date: '2026-10-03',
  allowed_team_sizes: [1],
  registration_state: 'open',
  member_pricing_enabled: false,
  non_member_fee_cents: null,
  payment_currency: 'EUR',
  members_only: false,
}

function jsonRes(body) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body }
}

function serve(data) {
  vi.stubGlobal('fetch', vi.fn((url) =>
    Promise.resolve(String(url).includes('/api/public/events/')
      ? jsonRes({ success: true, data })
      : jsonRes({ success: false }))
  ))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceSignupWidget — multiple times on a non-race event', () => {
  it('offers every time and requires a choice', async () => {
    serve({ ...base, waves: [
      { id: 'w8', start_time: '08:00:00', label: null, is_full: false },
      { id: 'w9', start_time: '09:00:00', label: null, is_full: false },
      { id: 'w18', start_time: '18:00:00', label: null, is_full: false },
    ] })
    render(<RaceSignupWidget slug="opening-day" />)
    await screen.findByText('Choose your time *')

    const eight = screen.getByRole('button', { name: /^08:00$/ })
    const nine = screen.getByRole('button', { name: /^09:00$/ })
    // No 90-minute release window outside races.
    expect(screen.getByRole('button', { name: /^18:00$/ })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/released as these waves fill/i)

    // Nothing pre-selected — two open times means the customer chooses.
    expect(eight.getAttribute('aria-pressed')).toBe('false')
    expect(nine.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(nine)
    expect(nine.getAttribute('aria-pressed')).toBe('true')

    // Details card summarises the choices instead of one time.
    expect(document.body.textContent).toContain('Starts at 08:00, 09:00 or 18:00')
  })

  it('greys a full time and pre-selects the one left', async () => {
    serve({ ...base, waves: [
      { id: 'w8', start_time: '08:00:00', label: null, is_full: true },
      { id: 'w9', start_time: '09:00:00', label: null, is_full: false },
    ] })
    render(<RaceSignupWidget slug="opening-day" />)
    await screen.findByText('Choose your time *')
    expect(screen.getByRole('button', { name: /08:00/ }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /^09:00$/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a single-time event picker-free', async () => {
    serve({ ...base, waves: [{ id: 'w9', start_time: '09:00:00', label: null, is_full: false }] })
    render(<RaceSignupWidget slug="opening-day" />)
    await screen.findByText('Starts at 09:00')
    expect(screen.queryByText('Choose your time *')).toBeNull()
    expect(screen.queryByRole('button', { name: /^09:00$/ })).toBeNull()
  })
})
