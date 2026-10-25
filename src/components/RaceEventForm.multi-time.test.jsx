// @vitest-environment jsdom
//
// EVENT-MULTITIME.1 — non-race events can carry more than one start time.
// The form must load every existing time (it used to read only waves[0],
// so saving a two-time event would have deleted the other one), let staff
// add and remove times, and send them all as waves on save.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}))

const EVENT = {
  id: 'ev-1',
  kind: 'open_day',
  name: 'Opening Day',
  slug: 'opening-day',
  race_date: '2026-10-03',
  allowed_team_sizes: [1],
  capacity_mode: 'people',
  active: true,
  waves: [
    { id: 'w9', start_time: '09:00:00', capacity: 28, label: null },
    { id: 'w8', start_time: '08:00:00', capacity: 20, label: null },
  ],
}

function stubFetch() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn((url, opts) => {
    calls.push({ url: String(url), opts })
    if (opts?.method === 'PUT' || opts?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
    }
    return new Promise(() => {})
  }))
  return calls
}

const slotTimes = (c) => [...c.querySelectorAll('input[title="Start time"]')].map((i) => i.value)
const slotCaps = (c) => [...c.querySelectorAll('input[title="Spots at this time (empty = unlimited)"]')].map((i) => i.value)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceEventForm — multiple times on a non-race event', () => {
  it('loads every existing time, sorted', () => {
    stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    expect(slotTimes(container)).toEqual(['08:00', '09:00'])
    expect(slotCaps(container)).toEqual(['20', '28'])
  })

  it('adds a time and saves all of them, keeping existing ids', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)

    fireEvent.click(screen.getByRole('button', { name: /Add another time/ }))
    const times = container.querySelectorAll('input[title="Start time"]')
    fireEvent.change(times[2], { target: { value: '10:00' } })

    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
    const body = JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)
    expect(body.waves.map((w) => [w.id ?? null, w.start_time, w.capacity])).toEqual([
      ['w8', '08:00', 20],
      ['w9', '09:00', 28],
      // A new row starts with the previous row's capacity.
      [null, '10:00', 28],
    ])
  })

  it('removes a time', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.click(screen.getAllByRole('button', { name: /Remove time/ })[0])
    expect(slotTimes(container)).toEqual(['09:00'])
    // Down to one time — nothing left to remove.
    expect(screen.queryByRole('button', { name: /Remove time/ })).toBeNull()

    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
    const body = JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)
    expect(body.waves.map((w) => w.id)).toEqual(['w9'])
  })

  it('refuses two identical times', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    fireEvent.click(screen.getByRole('button', { name: /Add another time/ }))
    fireEvent.change(container.querySelectorAll('input[title="Start time"]')[2], { target: { value: '09:00' } })
    fireEvent.submit(container.querySelector('form'))
    await screen.findByText(/Two times can't be the same \(09:00\)/)
    expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(false)
  })
})
