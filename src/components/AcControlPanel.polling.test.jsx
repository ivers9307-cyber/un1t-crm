// @vitest-environment jsdom
//
// SENSIBO-RATE.1 follow-up — the AC panel's polling behaviour.
//
// Two things a node-only suite cannot see, and both have already
// caused real incidents in this area:
//
//   1. The visibility gate actually gates. A "pause when hidden"
//      change that silently keeps polling looks identical to a
//      working one in a green suite — cf. the jsdom-can't-see-layout
//      class, where a toggle shipped doing nothing. Here we assert
//      the FETCH COUNT across a hide/show cycle, which is the thing
//      that mattered: until mig 580 each poll was a live Sensibo
//      call, and a forgotten background tab held the vendor's burst
//      budget at zero around the clock.
//
//   2. The reading is labelled with WHEN it was taken. It is served
//      from ac_devices.last_state now, so rendering it as "Live"
//      would state something false — the difference between "the AC
//      is off" and "the AC was off five minutes ago".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import AcControlPanel from './AcControlPanel'

const DEVICE = {
  id: 'dev-1', location_id: 'loc-1', label: 'Gym Floor AC (Sensibo)',
  provider: 'sensibo', device_group: 'Gym Floor', enabled: true,
  default_mode: 'cool', default_temp_c: 18, default_fan: 'high', session_minutes: 90,
}

// 2026-08-31T09:14 UTC = 10:14 Dublin (BST).
const OBSERVED_AT = '2026-08-31T09:14:07.234Z'

function mockRoutes({ stateAsOf = OBSERVED_AT, on = true } = {}) {
  global.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.endsWith('/api/studio-management/ac/devices')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: [DEVICE] }) }
    }
    if (u.includes('/api/studio-management/ac/devices/dev-1')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          success: true,
          data: {
            device: DEVICE,
            state: { on, mode: 'cool', target_temp_c: 18, fan: 'high' },
            state_as_of: stateAsOf,
            active_session: null,
            external_start: null,
          },
        }),
      }
    }
    throw new Error(`unexpected fetch ${u}`)
  })
}

function setHidden(hidden) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  setHidden(false)
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  delete global.fetch
})

describe('AcControlPanel — visibility-gated polling', () => {
  it('stops polling while the tab is hidden and resumes on return', async () => {
    mockRoutes()
    render(<AcControlPanel />)
    await waitFor(() => expect(screen.getByText(/Gym Floor AC/)).toBeTruthy())

    const afterMount = global.fetch.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    // Hidden: two full intervals must add NOTHING.
    setHidden(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000 * 2 + 1000) })
    expect(global.fetch.mock.calls.length).toBe(afterMount)

    // Returning to the tab refetches immediately, without waiting out
    // the interval — otherwise the operator stares at a stale card.
    await act(async () => { setHidden(false) })
    await waitFor(() => expect(global.fetch.mock.calls.length).toBeGreaterThan(afterMount))
  })

  it('keeps polling while the tab is visible', async () => {
    mockRoutes()
    render(<AcControlPanel />)
    await waitFor(() => expect(screen.getByText(/Gym Floor AC/)).toBeTruthy())

    const afterMount = global.fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000 + 1000) })
    expect(global.fetch.mock.calls.length).toBeGreaterThan(afterMount)
  })
})

describe('AcControlPanel — cached reading is labelled, not called "Live"', () => {
  it('renders an "as of" time in Dublin local time', async () => {
    mockRoutes({ stateAsOf: OBSERVED_AT })
    render(<AcControlPanel />)
    // 09:14 UTC on 31 Aug is BST, so the operator must see 10:14.
    await waitFor(() => expect(screen.getByText(/as of 10:14/)).toBeTruthy())
    expect(screen.queryByText(/Live:/)).toBeNull()
  })

  it('omits the "as of" clause when the device has never been observed', async () => {
    // NULL last_state_at — a device added before its first cron tick.
    // Better to say nothing than to invent a time.
    mockRoutes({ stateAsOf: null })
    render(<AcControlPanel />)
    await waitFor(() => expect(screen.getByText(/Gym Floor AC/)).toBeTruthy())
    expect(screen.queryByText(/as of/)).toBeNull()
  })
})
