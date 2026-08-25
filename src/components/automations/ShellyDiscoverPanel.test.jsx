// @vitest-environment jsdom
//
// SHELLY-UI.6 — discovery renders GET /api/shelly/discover verbatim. What the
// tests below actually protect:
//
//   * one chip per `adopted` value, and a foreign holder is NEVER named unless
//     the route sent a name (it only does so for the caller's own org)
//   * `supported: null` is adoptable — only an explicit false refuses, which
//     is what the adopt route does, and an offline plug reports null
//   * the count says "relays across devices", because a four-relay unit is one
//     device and four rows and the connection panel's `devices_seen` counts
//     the other one

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ShellyDiscoverPanel from './ShellyDiscoverPanel.jsx'

const row = (over = {}) => ({
  device_id: 'aabbccddeeff',
  channel: 0,
  name: 'Sauna plug',
  model: 'SNPL-00112EU',
  gen: 2,
  online: true,
  supported: true,
  adopted: null,
  ...over,
})

function mockFetch(reply) {
  global.fetch = vi.fn(async (url, init = {}) => reply(String(url), init))
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body })
const discovery = (devices) => json(200, { success: true, devices, row_count: devices.length })

async function find(devices) {
  mockFetch(() => discovery(devices))
  render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
  fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
  await waitFor(() => expect(screen.queryByText(/relay/)).toBeTruthy())
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('ShellyDiscoverPanel — the count', () => {
  it('counts RELAY ROWS across devices, never "devices found"', async () => {
    await find([
      row({ channel: 0 }), row({ channel: 1 }), row({ channel: 2 }), row({ channel: 3 }),
    ])
    expect(screen.getByText('4 relays across 1 device')).toBeTruthy()
    expect(screen.queryByText(/devices found/)).toBeNull()
  })

  it('singularises both halves', async () => {
    await find([row()])
    expect(screen.getByText('1 relay across 1 device')).toBeTruthy()
  })

  it('an empty account says so rather than showing an empty list', async () => {
    mockFetch(() => discovery([]))
    render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    await waitFor(() => expect(screen.getByText(/Nothing on this Shelly account yet/)).toBeTruthy())
  })
})

describe('ShellyDiscoverPanel — naming', () => {
  it('uses the account’s own device name when it has one', async () => {
    await find([row({ name: 'Sauna plug' })])
    expect(screen.getByText(/Sauna plug/)).toBeTruthy()
  })

  it('falls back to model + last 4 of the id when the account gave no name', async () => {
    await find([row({ name: null })])
    expect(screen.getByText(/SNPL-00112EU · eeff/)).toBeTruthy()
  })
})

describe('ShellyDiscoverPanel — one chip per adopted value', () => {
  it('adopted here: grey chip, no Adopt button', async () => {
    await find([row({ adopted: 'here' })])
    expect(screen.getByText('Adopted here')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Adopt' })).toBeNull()
  })

  it('same-org holder is named', async () => {
    await find([row({ adopted: 'elsewhere', elsewhere_location_name: 'Hatch Street' })])
    expect(screen.getByText('In use at Hatch Street')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Adopt' })).toBeNull()
  })

  it('a foreign holder is generic — no name is invented', async () => {
    await find([row({ adopted: 'elsewhere' })])
    expect(screen.getByText('In use elsewhere')).toBeTruthy()
    expect(screen.queryByText(/In use at/)).toBeNull()
  })

  it('unsupported: chip carries the reason as a title and there is no Adopt', async () => {
    await find([row({ supported: false, reason: 'gen1', gen: 1 })])
    const chip = screen.getByText('Not supported yet')
    expect(chip.getAttribute('title')).toBe('Gen1 devices are not supported yet')
    expect(screen.queryByRole('button', { name: 'Adopt' })).toBeNull()
  })

  it('no_switch gets its own reason copy', async () => {
    await find([row({ supported: false, reason: 'no_switch' })])
    expect(screen.getByText('Not supported yet').getAttribute('title'))
      .toBe('This device has no switch to control')
  })

  it('offline is a chip, not a refusal — an offline plug is still adoptable', async () => {
    await find([row({ online: false, supported: null })])
    expect(screen.getByText('Offline')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Adopt' })).toBeTruthy()
  })

  it('a locally-adopted id reads as adopted before the next Find', async () => {
    mockFetch(() => discovery([row()]))
    render(<ShellyDiscoverPanel adoptedIds={new Set(['aabbccddeeff_0'])} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    await waitFor(() => expect(screen.getByText('Adopted here')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Adopt' })).toBeNull()
  })
})

describe('ShellyDiscoverPanel — adopting', () => {
  it('POSTs { device_id, channel } and tells the parent', async () => {
    let sent = null
    let calls = 0
    global.fetch = vi.fn(async (url, init = {}) => {
      calls += 1
      if (String(url).includes('/discover')) return discovery([row({ channel: 2 })])
      sent = { url: String(url), method: init.method, body: JSON.parse(init.body) }
      return json(201, { success: true, device: { id: 'row-1' } })
    })
    const onAdopted = vi.fn()
    render(<ShellyDiscoverPanel adoptedIds={new Set()} onAdopted={onAdopted} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    const adopt = await screen.findByRole('button', { name: 'Adopt' })
    fireEvent.click(adopt)
    await waitFor(() => expect(onAdopted).toHaveBeenCalledWith({ id: 'row-1' }))
    expect(sent).toEqual({
      url: '/api/shelly/devices',
      method: 'POST',
      body: { device_id: 'aabbccddeeff', channel: 2 },
    })
    expect(calls).toBe(2)
  })

  it('renders the route’s refusal against the row that failed', async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).includes('/discover')
        ? discovery([row()])
        : json(409, { success: false, error: 'This device is already in use elsewhere', code: 'adopted' }))
    render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already in use elsewhere'))
  })

  it('renders the device-cap refusal', async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).includes('/discover')
        ? discovery([row()])
        : json(409, { success: false, error: 'This location has reached the limit of 50 devices', code: 'device_cap' }))
    render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('limit of 50 devices'))
  })

  it('renders a 404 not_on_account as the route worded it', async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).includes('/discover')
        ? discovery([row()])
        : json(404, { success: false, error: 'Not found on this Shelly account', code: 'not_on_account' }))
    render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Not found on this Shelly account'))
  })
})

describe('ShellyDiscoverPanel — discovery failures', () => {
  it('a key_rejected 409 points at the connection panel', async () => {
    mockFetch(() => json(409, {
      success: false, code: 'key_rejected',
      error: 'Shelly rejected the stored key — re-paste it from the Shelly app',
    }))
    render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('re-paste it from the Shelly app'))
    expect(screen.getByText(/Re-paste the cloud auth key in the Shelly account panel above/)).toBeTruthy()
  })

  it('a 429 rate limit is shown without the re-paste advice', async () => {
    mockFetch(() => json(429, { success: false, code: 'rate_limited', error: 'Shelly is busy — try again in a few seconds' }))
    render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Shelly is busy'))
    expect(screen.queryByText(/Re-paste the cloud auth key/)).toBeNull()
  })

  it('a dropped request still says something rather than rendering nothing', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline') })
    render(<ShellyDiscoverPanel adoptedIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /Find devices/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not read your Shelly account'))
  })
})
