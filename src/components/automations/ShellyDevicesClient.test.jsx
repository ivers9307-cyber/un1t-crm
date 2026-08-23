// @vitest-environment jsdom
//
// SHELLY-UI.6 — the page root, and the three states its two reads can be in.
//
// The assertions here exist because of a specific pair of route decisions:
// GET /api/shelly/connection answers 500 (not `connection: null`) on a
// transient database error, and GET /api/shelly/devices answers
// `connected: null` + `connection_status: 'unknown'` in the same situation —
// both so that a live studio is NEVER handed "not connected". A client that
// blanked itself, or fell back to the Connect form, would rebuild that exact
// failure one layer up.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import ShellyDevicesClient from './ShellyDevicesClient.jsx'

const CONNECTION = {
  host: 'shelly-68-eu.shelly.cloud',
  key_hint: 'ab12',
  has_auth_key: true,
  status: 'connected',
  last_ok_at: new Date(Date.now() - 60_000).toISOString(),
  last_error: null,
  last_error_at: null,
}

const DEVICE = {
  id: 'row-1',
  location_id: 'loc-1',
  device_id: 'aabbccddeeff',
  channel: 0,
  name: 'Sauna plug',
  model: 'SNPL-00112EU',
  gen: 2,
  zone: null,
  enabled: false,
  schedule_mode: 'none',
  fixed_windows: [],
  class_rule: {},
  override: null,
  last_applied: null,
  last_state: { online: true, output: false, apower: 0, aenergy_wh: 10, temperature_c: 30, source: 'schedule', at: new Date().toISOString() },
  last_seen_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body })

// A scripted pair of answers per poll round. Each entry is [connectionReply,
// devicesReply]; the last entry repeats.
function script(rounds) {
  let round = 0
  const seen = { connection: 0, devices: 0 }
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url)
    if (u === '/api/shelly/refresh') return json(200, { success: true, refreshed: 3, read_failures: 0, rate_limited: 0, kind: null })
    const pair = rounds[Math.min(round, rounds.length - 1)]
    if (u === '/api/shelly/connection' && (!init.method || init.method === 'GET')) {
      seen.connection += 1
      return pair[0]
    }
    if (u === '/api/shelly/devices') {
      seen.devices += 1
      // Both legs of a round are issued together; advance once both landed.
      if (seen.devices > round) round += 1
      return pair[1]
    }
    return json(200, { success: true })
  })
  return seen
}

const okConn = (over = {}) => json(200, { success: true, connection: CONNECTION, can_manage: true, device_count: 1, ...over })
const okDevices = (over = {}) => json(200, { success: true, devices: [DEVICE], connected: true, connection_status: 'connected', ...over })

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch; vi.useRealTimers() })

describe('ShellyDevicesClient — the happy path', () => {
  it('loads both reads in parallel on mount and renders a card per device', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())
    const urls = global.fetch.mock.calls.map((c) => String(c[0]))
    expect(urls).toContain('/api/shelly/connection')
    expect(urls).toContain('/api/shelly/devices')
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Find devices/ })).toBeTruthy()
  })

  it('trusts the server’s can_manage over the page’s prop once loaded', async () => {
    script([[okConn({ can_manage: false }), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText(/Managed by the studio owner/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Re-paste key/ })).toBeNull()
  })
})

describe('ShellyDevicesClient — the three connection states', () => {
  it('connection_status null shows the Connect form and no cards', async () => {
    script([[json(200, { success: true, connection: null, can_manage: true, device_count: 0 }),
      json(200, { success: true, devices: [], connected: false, connection_status: null })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Connect$/ })).toBeTruthy())
    expect(screen.queryByText('Sauna plug')).toBeNull()
    // Discovery needs a live connection.
    expect(screen.queryByRole('button', { name: /Find devices/ })).toBeNull()
  })

  it('connection_status "unknown" KEEPS the cards, keeps the controls, and never offers the Connect form', async () => {
    script([[json(500, { success: false, error: 'Could not read the Shelly connection' }),
      json(200, { success: true, devices: [DEVICE], connected: null, connection_status: 'unknown' })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)

    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())
    expect(screen.getByText('Couldn’t read the Shelly connection — retrying')).toBeTruthy()
    // ONE line about it, not two — the specific message replaces the generic.
    expect(screen.queryByText('Couldn’t refresh — retrying')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull()
    // Controls stay live: it is OUR read that failed, not the plug.
    expect(screen.getByRole('button', { name: 'On' }).disabled).toBe(false)
    // And the health grade never reaches red on an unknown connection.
    expect(screen.queryByText(/Stale/)).toBeNull()
  })

  it('action_needed and error are rendered as themselves, not as "not connected"', async () => {
    script([[okConn({ connection: { ...CONNECTION, status: 'action_needed', last_error: 'Shelly rejected the stored auth key' } }),
      okDevices({ connected: false, connection_status: 'action_needed' })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Action needed — re-paste the key')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Find devices/ })).toBeNull()
  })
})

describe('ShellyDevicesClient — a failed poll keeps the last good render', () => {
  it('keeps the cards and the connection panel, adding only a subordinate line', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([
      [okConn(), okDevices()],
      [json(500, { success: false, error: 'Could not read the Shelly connection' }),
        json(500, { success: false, error: 'Could not load your Shelly devices' })],
    ])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    await waitFor(() => expect(screen.getByText('Couldn’t refresh — retrying')).toBeTruthy())
    // NOTHING was blanked.
    expect(screen.getByText('Sauna plug')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'On' }).disabled).toBe(false)
  })

  it('clears the line as soon as a poll works again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([
      [okConn(), okDevices()],
      [json(500, { success: false }), json(500, { success: false })],
      [okConn(), okDevices()],
    ])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(screen.getByText('Couldn’t refresh — retrying')).toBeTruthy())

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(screen.queryByText('Couldn’t refresh — retrying')).toBeNull())
  })

  it('a first load that fails entirely says so — it does NOT offer the Connect form', async () => {
    script([[json(500, { success: false }), json(500, { success: false })]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Couldn’t read the Shelly connection — retrying')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull()
  })

  it('polls on a 30 s tick and stops while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const seen = script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(seen.devices).toBe(1))

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(seen.devices).toBe(2))

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(seen.devices).toBe(2)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(seen.devices).toBe(3))
  })
})

describe('ShellyDevicesClient — refresh', () => {
  it('reports the refreshed count and then debounces the button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    const button = screen.getByRole('button', { name: /Refresh/ })
    await act(async () => { button.click() })
    await waitFor(() => expect(screen.getByText('Refreshed 3 devices')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await waitFor(() => expect(screen.getByRole('button', { name: /Refresh/ }).disabled).toBe(false))
  })

  it('renders the route’s own error for a failed refresh', async () => {
    script([[okConn(), okDevices()]])
    render(<ShellyDevicesClient locationName="Stillorgan" glofoxConnected canManageConnection />)
    await waitFor(() => expect(screen.getByText('Sauna plug')).toBeTruthy())

    global.fetch.mockImplementation(async (url) => (String(url) === '/api/shelly/refresh'
      ? json(429, { success: false, error: 'Shelly is busy — try again in a few seconds', code: 'rate_limited' })
      : json(200, { success: true, devices: [DEVICE], connected: true, connection_status: 'connected' })))

    await act(async () => { screen.getByRole('button', { name: /Refresh/ }).click() })
    await waitFor(() => expect(screen.getByText('Shelly is busy — try again in a few seconds')).toBeTruthy())
  })
})
